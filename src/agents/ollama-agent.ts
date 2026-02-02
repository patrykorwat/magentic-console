import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  Agent,
  AgentConfig,
  AgentResponse,
  Message,
  Tool,
  ToolResult,
  FileAttachment,
  MCPServerConfig,
} from '../types/index.js';

export class OllamaAgent implements Agent {
  name: string;
  capabilities: string[];
  private baseUrl: string;
  private model: string;
  private systemPrompt: string;
  private temperature: number;
  private maxTokens: number;
  private tools: Tool[];
  private mcpClients: Map<string, Client> = new Map();
  private mcpTools: Tool[] = [];

  constructor(
    config: AgentConfig,
    baseUrl?: string,
    private mcpServers: MCPServerConfig[] = []
  ) {
    console.log(`[OllamaAgent] Constructor called with ${mcpServers.length} MCP server(s)`);
    if (mcpServers.length > 0) {
      console.log('[OllamaAgent] MCP servers:', mcpServers.map(s => s.name).join(', '));
    }

    this.name = config.name;
    this.baseUrl = baseUrl || 'http://localhost:11434';
    this.model = config.model || 'llama3.2';

    // Default system prompt - local AI assistant with MCP support
    const defaultPrompt =
      'Jesteś pomocnym asystentem AI działającym lokalnie. Specjalizujesz się w:' +
      '\n• Szybkiej analizie i przetwarzaniu informacji' +
      '\n• Odpowiadaniu na pytania w oparciu o dostarczone dane' +
      '\n• Pracujesz offline i chronisz prywatność użytkownika' +
      '\n\nJeśli masz dostęp do narzędzi MCP, używaj ich aktywnie do wykonywania zadań. ' +
      'Zawsze dostarczaj zwięzłe, konkretne odpowiedzi oparte na faktach i dostępnych danych.';

    // Use custom prompt if provided, otherwise use systemPrompt or default
    this.systemPrompt = config.customPrompt || config.systemPrompt || defaultPrompt;

    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = config.maxTokens || 4096;
    this.tools = config.tools || [];
    this.capabilities = [
      'local_inference',
      'privacy_focused',
      'offline_capable',
      'quick_analysis',
      'cost_free',
      'mcp_tools', // Added MCP capability
    ];
  }

  /**
   * Initialize MCP servers and load their tools
   */
  async initializeMCP(): Promise<void> {
    console.log(`[OllamaAgent] Starting MCP initialization with ${this.mcpServers.length} server(s)`);

    for (const serverConfig of this.mcpServers) {
      try {
        console.log(`[OllamaAgent] Initializing MCP server: ${serverConfig.name}`);
        console.log(`[OllamaAgent] Command: ${serverConfig.command} ${serverConfig.args.join(' ')}`);

        const transport = new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args,
          env: serverConfig.env,
        });

        console.log(`[OllamaAgent] Transport created for ${serverConfig.name}`);

        const client = new Client(
          {
            name: `ollama-agent-mcp-client-${serverConfig.name}`,
            version: '1.0.0',
          },
          {
            capabilities: {},
          }
        );

        await client.connect(transport);
        this.mcpClients.set(serverConfig.name, client);

        // List available tools from MCP server
        const toolsResponse = await client.listTools();

        // Convert MCP tools to our Tool format
        const mcpTools: Tool[] = toolsResponse.tools.map((tool) => ({
          name: `mcp_${serverConfig.name}_${tool.name}`,
          description: tool.description || '',
          inputSchema: tool.inputSchema as any,
        }));

        this.mcpTools.push(...mcpTools);
        console.log(
          `[OllamaAgent] Loaded ${mcpTools.length} tools from MCP server: ${serverConfig.name}`
        );
      } catch (error) {
        console.error(
          `[OllamaAgent] Failed to initialize MCP server ${serverConfig.name}:`,
          error
        );
      }
    }
  }

  /**
   * Close all MCP connections
   */
  async closeMCP(): Promise<void> {
    for (const [name, client] of this.mcpClients.entries()) {
      try {
        await client.close();
        console.log(`[OllamaAgent] Closed MCP server: ${name}`);
      } catch (error) {
        console.error(`[OllamaAgent] Error closing MCP server ${name}:`, error);
      }
    }
    this.mcpClients.clear();
  }

  getTools(): Tool[] {
    return [...this.tools, ...this.mcpTools];
  }

  async execute(messages: Message[]): Promise<AgentResponse> {
    return this.executeWithTools(messages, []);
  }

  async executeWithTools(
    messages: Message[],
    toolResults: ToolResult[]
  ): Promise<AgentResponse> {
    try {
      // Build Ollama-compatible messages
      const ollamaMessages = messages.map((msg) => {
        let content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

        // Add file information if present
        if (msg.files && msg.files.length > 0) {
          const fileContext = msg.files
            .map((f) => `\n[Plik: ${f.originalName} (${f.mimeType})]`)
            .join('');
          content += fileContext;
        }

        return {
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content,
        };
      });

      // Add system prompt as first message
      const messagesWithSystem = [
        { role: 'system', content: this.systemPrompt },
        ...ollamaMessages,
      ];

      // Add tool results if any
      if (toolResults.length > 0) {
        const toolResultsText = toolResults
          .map((tr) => `Tool ${tr.toolCallId} result: ${JSON.stringify(tr.output)}`)
          .join('\n');
        messagesWithSystem.push({
          role: 'user',
          content: `Tool results:\n${toolResultsText}`,
        });
      }

      // Call Ollama API
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: messagesWithSystem,
          stream: false,
          options: {
            temperature: this.temperature,
            num_predict: this.maxTokens,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      const content = data.message?.content || '';

      // Note: Ollama doesn't natively support tool calling like Claude
      // but we can simulate it by parsing the response for tool call patterns
      // For now, return simple response without tool calls
      return {
        content,
        stopReason: data.done ? 'end_turn' : 'max_tokens',
      };
    } catch (error) {
      console.error('[OllamaAgent] Error executing:', error);

      // Provide helpful error messages
      if (error instanceof Error) {
        if (error.message.includes('ECONNREFUSED')) {
          throw new Error(
            'Nie można połączyć się z Ollama. Upewnij się, że Ollama jest uruchomiona (ollama serve).'
          );
        }
      }
      throw error;
    }
  }

  /**
   * Execute MCP tool call
   */
  async executeMCPTool(toolName: string, input: Record<string, any>): Promise<any> {
    // Parse MCP tool name: mcp_{serverName}_{toolName}
    const match = toolName.match(/^mcp_([^_]+)_(.+)$/);
    if (!match) {
      throw new Error(`Invalid MCP tool name format: ${toolName}`);
    }

    const [, serverName, actualToolName] = match;
    const client = this.mcpClients.get(serverName);

    if (!client) {
      throw new Error(`MCP server not found: ${serverName}`);
    }

    try {
      const result = await client.callTool({
        name: actualToolName,
        arguments: input,
      });

      return result;
    } catch (error) {
      console.error(`[OllamaAgent] Error calling MCP tool ${toolName}:`, error);
      throw error;
    }
  }

  /**
   * Check if Ollama is available and running
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
      });
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get list of available models from Ollama
   */
  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json();
      return data.models?.map((m: any) => m.name) || [];
    } catch (error) {
      console.error('[OllamaAgent] Error listing models:', error);
      return [];
    }
  }

  /**
   * Set the model to use for this agent
   */
  setModel(model: string): void {
    console.log(`[OllamaAgent] Changing model from ${this.model} to ${model}`);
    this.model = model;
  }

  /**
   * Get the current model being used
   */
  getModel(): string {
    return this.model;
  }
}
