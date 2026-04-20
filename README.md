# ticket-ai-tier1

Express backend that processes support tickets using a two-stage AI pipeline.

## How it works

Incoming tickets go through a local classification step before hitting any paid API:

1. **Local filter** — heuristics detect SPAM (keyword scoring) and obvious non-urgent queries without calling any model.
2. **Ollama (llama3.2:3b)** — only triggered for ambiguous cases that might be urgent. Runs locally, no cost.
3. **Claude (claude-haiku-4-5)** — only called when a ticket is confirmed `URGENTE`. Returns a structured JSON with root cause, suggested fix, priority (1–5), and affected technology.

This tiered approach keeps Claude calls to a minimum while still giving detailed analysis where it matters.

## Categories

| Category | Description |
|---|---|
| `URGENTE` | Critical issue affecting multiple users or production systems |
| `CONSULTA` | Individual user question or non-critical problem |
| `SPAM` | Promotional email, phishing, or off-topic content |

## API

### `POST /api/process`

**Body**
```json
{ "ticket": "El servidor de producción está caído..." }
```

**Response**
```json
{
  "cleanTicket": "...",
  "category": "URGENTE",
  "analysis": {
    "problema_raiz": "...",
    "solucion_sugerida": "...",
    "prioridad": 1,
    "tecnologia_afectada": "..."
  }
}
```

`analysis` is `null` for `CONSULTA` and `SPAM` tickets.

## Setup

```bash
npm install
```

Create a `.env` file:
```
ANTHROPIC_API_KEY=your_key_here
```

Make sure Ollama is running locally with the `llama3.2:3b` model pulled:
```bash
ollama pull llama3.2:3b
ollama serve
```

Run the server:
```bash
npx tsx index.ts
```

Server starts on `http://localhost:3001`.
