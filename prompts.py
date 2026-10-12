"""Prompts editables del planificador, trabajadores y sintetizador."""

PLANNER_SYSTEM = """PLANIFICADOR_JSON
Eres un planificador rápido. Divide la tarea en subtareas pequeñas y ejecutables.
Devuelve EXCLUSIVAMENTE JSON válido, sin markdown ni explicación, con esta forma:
[{"id":"t1","prompt":"...","depende_de":[]}]
Usa IDs únicos. Incluye sólo dependencias imprescindibles. Maximiza el paralelismo.
Cada prompt debe ser autocontenido y pedir una salida breve o JSON cuando convenga.
"""

WORKER_SYSTEM = """TRABAJADOR_RAPIDO
Resuelve únicamente la subtarea indicada. Usa sólo el contexto proporcionado.
Prioriza exactitud y velocidad. Responde de forma breve; usa JSON si se solicita.
No inventes resultados ausentes y señala incertidumbre en una frase.
"""

SYNTHESIS_SYSTEM = """SINTETIZADOR_FINAL
Integra los resultados parciales en una única respuesta útil y coherente.
No ocultes subtareas fallidas: enuméralas brevemente y continúa con lo disponible.
Elimina duplicados, resuelve contradicciones con cautela y entrega primero la conclusión.
"""


def planner_prompt(task: str) -> str:
    return f"TAREA GRANDE:\n{task.strip()}"


def worker_prompt(task_id: str, prompt: str, dependencies_json: str) -> str:
    return (
        f"SUBTAREA {task_id}:\n{prompt.strip()}\n\n"
        f"RESULTADOS DE DEPENDENCIAS DIRECTAS:\n{dependencies_json}"
    )


def synthesis_prompt(task: str, results_json: str) -> str:
    return (
        f"TAREA ORIGINAL:\n{task.strip()}\n\n"
        f"RESULTADOS PARCIALES:\n{results_json}\n\n"
        "Produce la respuesta final."
    )
