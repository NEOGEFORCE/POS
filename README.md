# Orquestador asyncio + Claude/GPT

Divide tareas en un DAG, ejecuta nodos listos en paralelo y sintetiza el resultado.

## Instalación

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
```

Configura sólo la clave del proveedor que usarás:

```powershell
$env:ANTHROPIC_API_KEY="tu-clave-claude"
$env:OPENAI_API_KEY="tu-clave-openai"
```

## Uso

```powershell
python ejemplo.py                              # benchmark local
python ejemplo.py --provider anthropic         # Claude
python ejemplo.py --provider openai            # GPT
python ejemplo.py "Tu tarea" --provider gpt
```

Desde código: `await Orchestrator(OrchestratorConfig(provider="openai")).run("tarea")`.
La caché vive en `.cache/`; modelos, concurrencia y timeouts están en `config.py`.
