"""Ejemplo y benchmark. Usa --real para llamar a Anthropic."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import time

from config import OrchestratorConfig
from orquestador import Orchestrator
from prompts import PLANNER_SYSTEM, SYNTHESIS_SYSTEM, WORKER_SYSTEM


class DemoTransport:
    """Simula latencia de red para probar DAG, velocidad y fallos sin gastar API."""

    cache_namespace = "demo"

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
        if PLANNER_SYSTEM.splitlines()[0] in system_prompt:
            await asyncio.sleep(0.08)
            return json.dumps([
                {"id": "t1", "prompt": "Extrae los objetivos principales", "depende_de": []},
                {"id": "t2", "prompt": "Clasifica los riesgos y restricciones", "depende_de": []},
                {"id": "t3", "prompt": "Resume una solución usando t1", "depende_de": ["t1"]},
                {"id": "t4", "prompt": "Formatea recomendaciones usando t2", "depende_de": ["t2"]},
            ])
        if WORKER_SYSTEM.splitlines()[0] in system_prompt:
            await asyncio.sleep(0.35)
            task_id = user_prompt.split(":", 1)[0].replace("SUBTAREA", "").strip()
            return json.dumps({"subtarea": task_id, "resultado": "completado"})
        if SYNTHESIS_SYSTEM.splitlines()[0] in system_prompt:
            await asyncio.sleep(0.10)
            return "Síntesis demo completada con todos los resultados parciales."
        raise RuntimeError(f"prompt de sistema desconocido para {model}")


async def benchmark_demo(task: str) -> None:
    config = OrchestratorConfig(cache_enabled=False, retry_base_seconds=0.01)
    orchestrator = Orchestrator(config=config, transport=DemoTransport())

    async def measured(parallel: bool) -> tuple[float, str]:
        started = time.perf_counter()
        result = await orchestrator.run_details(
            task, parallel=parallel, use_cache=False
        )
        return time.perf_counter() - started, result.answer

    print("\n=== EJECUCIÓN EN SERIE ===")
    serial_time, _ = await measured(False)
    print("\n=== EJECUCIÓN EN PARALELO ===")
    parallel_time, answer = await measured(True)
    speedup = serial_time / parallel_time if parallel_time else float("inf")
    print(f"\nSerie: {serial_time:.2f}s")
    print(f"Paralelo: {parallel_time:.2f}s")
    print(f"Aceleración: {speedup:.2f}x")
    print(f"Resultado: {answer}")


async def run_real(task: str, provider: str) -> None:
    normalized = "openai" if provider == "gpt" else provider
    key_name = "OPENAI_API_KEY" if normalized == "openai" else "ANTHROPIC_API_KEY"
    if not os.getenv(key_name):
        raise SystemExit(f"Falta {key_name}; configúrala o usa --provider demo")
    orchestrator = Orchestrator(config=OrchestratorConfig(provider=normalized))
    try:
        result = await orchestrator.run_details(task)
        print("\n=== RESULTADO ===\n" + result.answer)
    finally:
        await orchestrator.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "task",
        nargs="?",
        default="Diseña un plan breve para lanzar una tienda online fiable y rápida.",
    )
    parser.add_argument(
        "--provider",
        choices=("demo", "anthropic", "openai", "gpt"),
        default="demo",
        help="proveedor real o benchmark local",
    )
    parser.add_argument(
        "--real",
        action="store_true",
        help="compatibilidad: usa ORCH_PROVIDER (anthropic por defecto)",
    )
    args = parser.parse_args()
    provider = args.provider
    if args.real and provider == "demo":
        provider = os.getenv("ORCH_PROVIDER", "anthropic").lower()
    asyncio.run(
        benchmark_demo(args.task) if provider == "demo" else run_real(args.task, provider)
    )


if __name__ == "__main__":
    main()
