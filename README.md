# Magentic Agent Orchestrator

A TypeScript multi-agent system implementing the **Magentic Orchestration Pattern** with Claude, Gemini, and Ollama agents.

![Web UI](UI.png)

## Features

- **Multi-Agent System**: Manager, Claude, Gemini, and Ollama agents working together
- **Automatic Planning**: Break down complex tasks into executable steps
- **Cross-Agent Tools**: Claude can invoke Gemini for web search and summarization
- **MCP Support**: Connect Claude to Model Context Protocol servers
- **Local AI**: Run Ollama models locally for privacy and cost savings
- **Web UI**: Full-featured interface for configuration and execution
- **Real-Time Updates**: Live task execution monitoring via WebSocket

## Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure API keys:**
   ```bash
   cp .env.example .env
   # Edit .env and add your API keys
   ```

3. **(Optional) Install Ollama for local models:**
   ```bash
   # Install Ollama from https://ollama.com
   ollama pull llama3.2
   ollama serve
   ```

4. **Start the Web UI:**
   ```bash
   npm run ui
   ```
   Then open [http://localhost:3001](http://localhost:3001)

See [UI_GUIDE.md](UI_GUIDE.md) for detailed usage instructions.

## Configuration

### API Keys

Edit `.env` and add your API keys:
```env
ANTHROPIC_API_KEY=your_claude_api_key_here
GOOGLE_API_KEY=your_gemini_api_key_here
```

### Ollama (Optional)

Configure Ollama base URL if not using default:
```env
OLLAMA_BASE_URL=http://localhost:11434
```

**Konfiguracja modeli Ollama:**

Edytuj plik `ollama-models.json` aby dostosować listę dostępnych modeli Ollama:

```json
{
  "models": [
    {
      "id": "qwen2.5:7b",
      "name": "Qwen 2.5 (7B)",
      "description": "Najlepszy balans jakości i szybkości. Doskonały do większości zadań.",
      "capabilities": ["reasoning", "coding", "analysis", "mcp_tools"],
      "recommended": true
    }
  ],
  "defaultModel": "qwen2.5:7b"
}
```

Manager Agent użyje tych opisów aby wybrać najbardziej odpowiedni model Ollama dla każdego zadania.

### MCP Servers (Optional)

Configure Model Context Protocol servers in `.env`:
```env
MCP_SERVERS='[{"name":"filesystem","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}]'
```

Or configure them through the Web UI Settings page.

## Usage

### Programmatic Usage

```typescript
import { MagenticOrchestrator } from './src/index.js';

const orchestrator = new MagenticOrchestrator({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
  googleApiKey: process.env.GOOGLE_API_KEY!,
  // Optional: Enable Ollama
  ollamaConfig: {
    model: 'llama3.2',
    temperature: 0.7,
    maxTokens: 4096,
  },
  ollamaBaseUrl: 'http://localhost:11434',
});

await orchestrator.initialize();

// Execute task with automatic planning
const result = await orchestrator.executeTask(
  'Find the latest TypeScript features and create a summary',
  true
);

// Or chat directly with Ollama
const response = await orchestrator.chat('Explain async/await', 'ollama');

await orchestrator.cleanup();
```

See [examples/](examples/) for more usage examples.

## Architecture

The system uses four specialized agents:

1. **Manager Agent** - Plans tasks and delegates to appropriate agents
2. **Claude Agent** - Handles deep reasoning, code analysis, complex tasks, PDF analysis, and MCP tools (paid)
3. **Gemini Agent** - Handles web search, summarization, and quick queries (paid)
4. **Ollama Agent** - Local open-source models for privacy-focused, offline tasks (free)

The Manager Agent automatically selects the most cost-effective agent for each task:
- **Ollama** for simple text analysis (free, local)
- **Gemini** for web search and medium complexity tasks (affordable)
- **Claude** for complex reasoning, PDF analysis, and database operations (premium)

Claude can invoke Gemini dynamically using cross-agent tool calling when it needs web search or summarization capabilities.

## Documentation

- [UI_GUIDE.md](UI_GUIDE.md) - Detailed Web UI guide
- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture details
- [examples/](examples/) - Code examples

## License

AGPL-3.0

## References

- [Magentic Orchestration Pattern](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns#magentic-orchestration)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Anthropic Claude API](https://docs.anthropic.com/)
- [Google Gemini API](https://ai.google.dev/)
- [Ollama](https://ollama.com/) - Run large language models locally
