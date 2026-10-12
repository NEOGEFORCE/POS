"""Orquestador asyncio rápido y tolerante a fallos para Anthropic."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Protocol, Sequence

from anthropic import AsyncAnthropic
from openai import AsyncOpenAI

from config import DEFAULT_CONFIG, OrchestratorConfig
from prompts import (
    PLANNER_SYSTEM,
    SYNTHESIS_SYSTEM,
    WORKER_SYSTEM,
    planner_prompt,
    synthesis_prompt,
    worker_prompt,
)


class CompletionTransport(Protocol):
    async def complete(
        self,
        *,
        model: str,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int,
        timeout: float,
        shared_context: str = "",
    ) -> str: ...


class AnthropicTransport:
    """Adaptador mínimo del SDK; desactiva reintentos internos para no duplicarlos."""

    cache_namespace = "anthropic"

    def __init__(self, config: OrchestratorConfig, api_key: str | None = None) -> None:
        key = api_key or os.getenv("ANTHROPIC_API_KEY")
        if not key:
            raise RuntimeError("Falta la variable de entorno ANTHROPIC_API_KEY")
        self._client = AsyncAnthropic(api_key=key, max_retries=0)
        self._cache_threshold = config.shared_context_cache_min_chars

    async def complete(
        self,
        *,
        model: str,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int,
        timeout: float,
        shared_context: str = "",
    ) -> str:
        system: str | list[dict[str, Any]]
        if shared_context:
            context_block: dict[str, Any] = {
                "type": "text",
                "text": f"CONTEXTO COMPARTIDO:\n{shared_context}",
            }
            if len(shared_context) >= self._cache_threshold:
                context_block["cache_control"] = {"type": "ephemeral"}
            system = [{"type": "text", "text": system_prompt}, context_block]
        else:
            system = system_prompt

        response = await self._client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user_prompt}],
            timeout=timeout,
        )
        text = "".join(
            block.text for block in response.content if getattr(block, "type", None) == "text"
        ).strip()
        if not text:
            raise RuntimeError("Anthropic devolvió una respuesta sin bloques de texto")
        return text

    async def close(self) -> None:
        await self._client.close()


class OpenAITransport:
    """Adaptador GPT con Responses API y caché de prompt para contexto largo."""

    cache_namespace = "openai"

    def __init__(self, config: OrchestratorConfig, api_key: str | None = None) -> None:
        key = api_key or os.getenv("OPENAI_API_KEY")
        if not key:
            raise RuntimeError("Falta la variable de entorno OPENAI_API_KEY")
        self._client = AsyncOpenAI(api_key=key, max_retries=0)
        self._cache_threshold = config.shared_context_cache_min_chars

    async def complete(
        self,
        *,
        model: str,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int,
        timeout: float,
        shared_context: str = "",
    ) -> str:
        instructions = system_prompt
        request: dict[str, Any] = {
            "model": model,
            "instructions": instructions,
            "input": user_prompt,
            "max_output_tokens": max_tokens,
            "timeout": timeout,
        }
        if shared_context:
            instructions += f"\n\nCONTEXTO COMPARTIDO:\n{shared_context}"
            request["instructions"] = instructions
            if len(shared_context) >= self._cache_threshold:
                request["prompt_cache_key"] = hashlib.sha256(
                    shared_context.encode("utf-8")
                ).hexdigest()

        response = await self._client.responses.create(**request)
        text = (response.output_text or "").strip()
        if not text:
            raise RuntimeError("OpenAI devolvió una respuesta sin texto")
        return text

    async def close(self) -> None:
        await self._client.close()


def create_transport(config: OrchestratorConfig) -> CompletionTransport:
    if config.provider == "openai":
        return OpenAITransport(config)
    return AnthropicTransport(config)


@dataclass(frozen=True, slots=True)
class Subtask:
    id: str
    prompt: str
    depende_de: tuple[str, ...] = ()


@dataclass(slots=True)
class TaskResult:
    id: str
    status: str
    output: str = ""
    error: str = ""
    elapsed_seconds: float = 0.0
    attempts: int = 0
    cached: bool = False

    def compact(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "output": self.output,
            "error": self.error,
        }


@dataclass(slots=True)
class OrchestrationResult:
    answer: str
    plan: list[Subtask]
    results: list[TaskResult]
    elapsed_seconds: float


class DiskCache:
    def __init__(self, directory: Path) -> None:
        self.directory = directory

    @staticmethod
    def key(payload: dict[str, Any]) -> str:
        raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def _path(self, key: str) -> Path:
        return self.directory / f"{key}.json"

    def _load_sync(self, key: str) -> str | None:
        path = self._path(key)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            value = data.get("value")
            return value if isinstance(value, str) else None
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            return None

    async def load(self, key: str) -> str | None:
        return await asyncio.to_thread(self._load_sync, key)

    def _save_sync(self, key: str, value: str) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(
            {"value": value, "created_at": time.time()}, ensure_ascii=False
        )
        fd, temp_name = tempfile.mkstemp(prefix=f"{key}.", suffix=".tmp", dir=self.directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
            os.replace(temp_name, self._path(key))
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)

    async def save(self, key: str, value: str) -> None:
        await asyncio.to_thread(self._save_sync, key, value)


class ModelCallError(RuntimeError):
    pass


class Orchestrator:
    def __init__(
        self,
        config: OrchestratorConfig | None = None,
        transport: CompletionTransport | None = None,
    ) -> None:
        self.config = config or DEFAULT_CONFIG
        self.transport = transport or create_transport(self.config)
        self.cache = DiskCache(self.config.cache_dir)
        self.semaphore = asyncio.Semaphore(self.config.max_concurrency)

    async def close(self) -> None:
        close = getattr(self.transport, "close", None)
        if close:
            await close()

    async def _complete(
        self,
        *,
        model: str,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int,
        timeout: float,
        shared_context: str = "",
        use_cache: bool = True,
    ) -> tuple[str, bool, int]:
        payload = {
            "v": 1,
            "transport": getattr(self.transport, "cache_namespace", type(self.transport).__name__),
            "model": model,
            "system": system_prompt,
            "user": user_prompt,
            "shared_context": shared_context,
            "max_tokens": max_tokens,
        }
        key = self.cache.key(payload)
        cache_on = self.config.cache_enabled and use_cache
        if cache_on:
            cached = await self.cache.load(key)
            if cached is not None:
                return cached, True, 0

        last_error: Exception | None = None
        total_attempts = self.config.max_retries + 1
        for attempt in range(1, total_attempts + 1):
            try:
                async with self.semaphore:
                    text = await asyncio.wait_for(
                        self.transport.complete(
                            model=model,
                            system_prompt=system_prompt,
                            user_prompt=user_prompt,
                            max_tokens=max_tokens,
                            timeout=timeout,
                            shared_context=shared_context,
                        ),
                        timeout=timeout,
                    )
                if cache_on:
                    await self.cache.save(key, text)
                return text, False, attempt
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # red, rate limit, timeout o respuesta inválida
                last_error = exc
                if attempt < total_attempts:
                    await asyncio.sleep(self.config.retry_base_seconds * (2 ** (attempt - 1)))

        raise ModelCallError(
            f"falló tras {total_attempts} intentos: {type(last_error).__name__}: {last_error}"
        ) from last_error

    @staticmethod
    def _extract_json_array(text: str) -> list[Any]:
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.IGNORECASE)
        start = cleaned.find("[")
        if start < 0:
            raise ValueError("el plan no contiene un array JSON")
        value, _ = json.JSONDecoder().raw_decode(cleaned[start:])
        if not isinstance(value, list):
            raise ValueError("el plan JSON no es una lista")
        return value

    def _validate_plan(self, raw: Sequence[Any]) -> list[Subtask]:
        if not raw:
            raise ValueError("el plan está vacío")
        if len(raw) > self.config.max_plan_tasks:
            raise ValueError(f"el plan supera {self.config.max_plan_tasks} subtareas")

        tasks: list[Subtask] = []
        seen: set[str] = set()
        for index, item in enumerate(raw, start=1):
            if not isinstance(item, dict):
                raise ValueError(f"subtarea {index} no es un objeto")
            task_id = str(item.get("id", "")).strip()
            prompt = str(item.get("prompt", "")).strip()
            dependencies = item.get("depende_de", [])
            if not task_id or not prompt or not isinstance(dependencies, list):
                raise ValueError(f"subtarea {index} tiene forma inválida")
            if task_id in seen:
                raise ValueError(f"id duplicado: {task_id}")
            seen.add(task_id)
            tasks.append(Subtask(task_id, prompt, tuple(str(x).strip() for x in dependencies)))

        ids = {task.id for task in tasks}
        for task in tasks:
            missing = set(task.depende_de) - ids
            if missing:
                raise ValueError(f"{task.id} depende de IDs inexistentes: {sorted(missing)}")
            if task.id in task.depende_de:
                raise ValueError(f"{task.id} depende de sí misma")
        return self._topological_sort(tasks)

    @staticmethod
    def _topological_sort(tasks: Sequence[Subtask]) -> list[Subtask]:
        by_id = {task.id: task for task in tasks}
        incoming = {task.id: set(task.depende_de) for task in tasks}
        ready = [task.id for task in tasks if not incoming[task.id]]
        ordered: list[Subtask] = []

        while ready:
            current = ready.pop(0)
            ordered.append(by_id[current])
            for task in tasks:
                if current in incoming[task.id]:
                    incoming[task.id].remove(current)
                    if not incoming[task.id] and task.id not in {x.id for x in ordered} and task.id not in ready:
                        ready.append(task.id)
        if len(ordered) != len(tasks):
            raise ValueError("el plan contiene un ciclo de dependencias")
        return ordered

    async def plan(
        self, task: str, shared_context: str = "", *, use_cache: bool = True
    ) -> list[Subtask]:
        print("[plan] iniciando")
        started = time.perf_counter()
        try:
            text, cached, _ = await self._complete(
                model=self.config.planner_model,
                system_prompt=PLANNER_SYSTEM,
                user_prompt=planner_prompt(task),
                max_tokens=self.config.planner_max_tokens,
                timeout=self.config.planner_timeout_seconds,
                shared_context=shared_context,
                use_cache=use_cache,
            )
            plan = self._validate_plan(self._extract_json_array(text))
            suffix = " caché" if cached else ""
            print(f"[plan] terminado{suffix} ({time.perf_counter() - started:.2f}s, {len(plan)} tareas)")
            return plan
        except Exception as exc:
            print(f"[plan] falló ({time.perf_counter() - started:.2f}s): {exc}; usando plan mínimo")
            return [Subtask("t1", task.strip(), ())]

    def _worker_tokens(self, prompt: str) -> int:
        simple = ("extrae", "clasifica", "formatea", "lista", "identifica")
        medium = ("resume", "compara", "analiza")
        normalized = prompt.lower()
        if any(word in normalized for word in simple):
            return max(300, min(400, self.config.worker_max_tokens))
        if any(word in normalized for word in medium):
            return max(300, min(600, self.config.worker_max_tokens))
        return max(300, min(800, self.config.worker_max_tokens))

    async def _run_worker(
        self,
        subtask: Subtask,
        dependency_results: Sequence[TaskResult],
        shared_context: str,
        use_cache: bool,
    ) -> TaskResult:
        started = time.perf_counter()
        print(f"[{subtask.id}] empezó")
        dependencies_json = json.dumps(
            [result.compact() for result in dependency_results],
            ensure_ascii=False,
            separators=(",", ":"),
        )
        try:
            output, cached, attempts = await self._complete(
                model=self.config.worker_model,
                system_prompt=WORKER_SYSTEM,
                user_prompt=worker_prompt(subtask.id, subtask.prompt, dependencies_json),
                max_tokens=self._worker_tokens(subtask.prompt),
                timeout=self.config.subtask_timeout_seconds,
                shared_context=shared_context,
                use_cache=use_cache,
            )
            elapsed = time.perf_counter() - started
            suffix = " caché" if cached else ""
            print(f"[{subtask.id}] terminó{suffix} ({elapsed:.2f}s)")
            return TaskResult(subtask.id, "ok", output, elapsed_seconds=elapsed, attempts=attempts, cached=cached)
        except Exception as exc:
            elapsed = time.perf_counter() - started
            print(f"[{subtask.id}] falló ({elapsed:.2f}s): {exc}")
            return TaskResult(subtask.id, "failed", error=str(exc), elapsed_seconds=elapsed, attempts=self.config.max_retries + 1)

    async def execute_plan(
        self,
        plan: Sequence[Subtask],
        shared_context: str = "",
        *,
        parallel: bool = True,
        use_cache: bool = True,
    ) -> list[TaskResult]:
        ordered = self._topological_sort(plan)
        if not parallel:
            completed: dict[str, TaskResult] = {}
            for subtask in ordered:
                deps = [completed[dep] for dep in subtask.depende_de]
                completed[subtask.id] = await self._run_worker(subtask, deps, shared_context, use_cache)
            return [completed[task.id] for task in ordered]

        futures: dict[str, asyncio.Task[TaskResult]] = {}
        for subtask in ordered:
            async def runner(spec: Subtask = subtask) -> TaskResult:
                deps = await asyncio.gather(*(futures[dep] for dep in spec.depende_de))
                return await self._run_worker(spec, deps, shared_context, use_cache)

            futures[subtask.id] = asyncio.create_task(runner(), name=f"worker-{subtask.id}")

        gathered = await asyncio.gather(*(futures[task.id] for task in ordered))
        return list(gathered)

    async def synthesize(
        self,
        task: str,
        results: Sequence[TaskResult],
        shared_context: str = "",
        *,
        use_cache: bool = True,
    ) -> str:
        print("[síntesis] iniciando")
        payload = json.dumps(
            [result.compact() for result in results],
            ensure_ascii=False,
            separators=(",", ":"),
        )
        try:
            answer, cached, _ = await self._complete(
                model=self.config.synthesis_model,
                system_prompt=SYNTHESIS_SYSTEM,
                user_prompt=synthesis_prompt(task, payload),
                max_tokens=self.config.synthesis_max_tokens,
                timeout=self.config.synthesis_timeout_seconds,
                shared_context=shared_context,
                use_cache=use_cache,
            )
            print(f"[síntesis] terminada{' caché' if cached else ''}")
            return answer
        except Exception as exc:
            print(f"[síntesis] falló: {exc}; devolviendo síntesis local")
            lines = ["Resultado parcial (falló la síntesis remota):"]
            for result in results:
                value = result.output if result.status == "ok" else f"ERROR: {result.error}"
                lines.append(f"- {result.id}: {value}")
            return "\n".join(lines)

    async def run_details(
        self,
        task: str,
        shared_context: str = "",
        *,
        parallel: bool = True,
        use_cache: bool = True,
    ) -> OrchestrationResult:
        if not task.strip():
            raise ValueError("la tarea no puede estar vacía")
        started = time.perf_counter()
        plan = await self.plan(task, shared_context, use_cache=use_cache)
        results = await self.execute_plan(
            plan, shared_context, parallel=parallel, use_cache=use_cache
        )
        answer = await self.synthesize(
            task, results, shared_context, use_cache=use_cache
        )
        elapsed = time.perf_counter() - started
        print(f"[total] {elapsed:.2f}s")
        return OrchestrationResult(answer, plan, results, elapsed)

    async def run(
        self,
        task: str,
        shared_context: str = "",
        *,
        parallel: bool = True,
        use_cache: bool = True,
    ) -> str:
        return (await self.run_details(task, shared_context, parallel=parallel, use_cache=use_cache)).answer


async def orchestrate(task: str, shared_context: str = "") -> str:
    orchestrator = Orchestrator()
    try:
        return await orchestrator.run(task, shared_context)
    finally:
        await orchestrator.close()
