"""Configuración central del orquestador."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

# Proveedor/modelos editables; también aceptan variables ORCH_*.
PROVIDER = os.getenv("ORCH_PROVIDER", "anthropic").lower()
ANTHROPIC_PLANNER_MODEL = "claude-sonnet-5-5"
ANTHROPIC_WORKER_MODEL = "claude-sonnet-5-5"
ANTHROPIC_SYNTHESIS_MODEL = ANTHROPIC_PLANNER_MODEL
OPENAI_PLANNER_MODEL = "gpt-5.6"
OPENAI_WORKER_MODEL = "gpt-5.6"
OPENAI_SYNTHESIS_MODEL = OPENAI_PLANNER_MODEL


@dataclass(slots=True)
class OrchestratorConfig:
    provider: str = PROVIDER
    planner_model: str | None = field(default_factory=lambda: os.getenv("ORCH_PLANNER_MODEL"))
    worker_model: str | None = field(default_factory=lambda: os.getenv("ORCH_WORKER_MODEL"))
    synthesis_model: str | None = field(default_factory=lambda: os.getenv("ORCH_SYNTHESIS_MODEL"))
    max_concurrency: int = 5
    subtask_timeout_seconds: float = 60.0
    planner_timeout_seconds: float = 60.0
    synthesis_timeout_seconds: float = 90.0
    max_retries: int = 2
    retry_base_seconds: float = 0.75
    planner_max_tokens: int = 1_200
    worker_max_tokens: int = 800
    synthesis_max_tokens: int = 1_200
    max_plan_tasks: int = 30
    shared_context_cache_min_chars: int = 2_048
    cache_enabled: bool = True
    cache_dir: Path = field(default_factory=lambda: BASE_DIR / ".cache")

    def __post_init__(self) -> None:
        self.provider = self.provider.lower().strip()
        if self.provider == "gpt":
            self.provider = "openai"
        if self.provider not in {"anthropic", "openai"}:
            raise ValueError("provider debe ser 'anthropic', 'openai' o 'gpt'")
        if self.provider == "openai":
            self.planner_model = self.planner_model or OPENAI_PLANNER_MODEL
            self.worker_model = self.worker_model or OPENAI_WORKER_MODEL
            self.synthesis_model = self.synthesis_model or OPENAI_SYNTHESIS_MODEL
        else:
            self.planner_model = self.planner_model or ANTHROPIC_PLANNER_MODEL
            self.worker_model = self.worker_model or ANTHROPIC_WORKER_MODEL
            self.synthesis_model = self.synthesis_model or ANTHROPIC_SYNTHESIS_MODEL


DEFAULT_CONFIG = OrchestratorConfig()
