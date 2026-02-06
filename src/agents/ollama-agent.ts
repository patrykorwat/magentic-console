import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  Agent,
  AgentConfig,
  AgentResponse,
  Message,
  Tool,
  ToolCall,
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

    // System prompt is now loaded from config/ollama-prompts.json via customPrompt
    // Default fallback prompt if no customPrompt provided
    const defaultPrompt =
      'Jesteś pomocnym asystentem AI działającym lokalnie.' +
      '\n\nMAŻ DOSTĘP DO NARZĘDZI MCP. Gdy potrzebujesz wykonać operację, MUSISZ użyć narzędzi.' +
      '\n\nFORMAT WYWOŁANIA NARZĘDZI:' +
      '\n```json' +
      '\n{"tool_calls": [{"id": "call_1", "name": "nazwa_narzędzia", "input": {...}}]}' +
      '\n```' +
      '\n\nNIE GENERUJ PRZYKŁADOWYCH WYNIKÓW! Użyj narzędzia i poczekaj na prawdziwy wynik.';

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

  /**
   * Parse tool calls from Ollama response content
   * Looks for JSON blocks with tool_calls array
   */
  private parseToolCalls(content: string): ToolCall[] {
    const toolCalls: ToolCall[] = [];

    // Format 1: Try to parse XML <tool_call> tags (Bielik format)
    const xmlToolCallRegex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
    let xmlMatch;

    while ((xmlMatch = xmlToolCallRegex.exec(content)) !== null) {
      try {
        const jsonContent = xmlMatch[1];
        console.log(`[OllamaAgent] Raw XML tool call JSON: ${jsonContent}`);
        const parsed = JSON.parse(jsonContent);

        if (parsed.name && (parsed.arguments || parsed.input || parsed.parameters)) {
          toolCalls.push({
            id: parsed.id || `call_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
            name: parsed.name,
            input: parsed.arguments || parsed.input || parsed.parameters
          });
          console.log(`[OllamaAgent] Parsed XML tool call: ${parsed.name}`);
        }
      } catch (error) {
        console.warn('[OllamaAgent] Failed to parse XML tool call:', error);
      }
    }

    // Format 2: Try to find JSON code blocks with tool_calls
    const jsonBlockRegex = /```json\s*\n([\s\S]*?)\n```/g;
    let match;

    while ((match = jsonBlockRegex.exec(content)) !== null) {
      try {
        const jsonContent = match[1];
        const parsed = JSON.parse(jsonContent);

        // Format 1: {"tool_calls": [{...}]}
        if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
          for (const call of parsed.tool_calls) {
            if (call.name && call.input) {
              toolCalls.push({
                id: call.id || `call_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
                name: call.name,
                input: call.input
              });
            }
          }
        }
        // Format 2: Single tool call object {"name": "...", "parameters"/"input": {...}}
        else if (parsed.name && (parsed.parameters || parsed.input)) {
          toolCalls.push({
            id: parsed.id || `call_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
            name: parsed.name,
            input: parsed.parameters || parsed.input
          });
        }
      } catch (error) {
        console.warn('[OllamaAgent] Failed to parse JSON block:', error);
      }
    }

    // Format 3: Also try to parse the entire content as JSON if no code blocks found
    if (toolCalls.length === 0) {
      try {
        const parsed = JSON.parse(content.trim());

        // Format 1: {"tool_calls": [{...}]}
        if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
          for (const call of parsed.tool_calls) {
            if (call.name && call.input) {
              toolCalls.push({
                id: call.id || `call_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
                name: call.name,
                input: call.input
              });
            }
          }
        }
        // Format 2: Single tool call object {"name": "...", "parameters"/"input": {...}}
        else if (parsed.name && (parsed.parameters || parsed.input)) {
          toolCalls.push({
            id: parsed.id || `call_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
            name: parsed.name,
            input: parsed.parameters || parsed.input
          });
        }
      } catch (error) {
        // Content is not JSON, that's fine - no tool calls
      }
    }

    return toolCalls;
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

      // Build system prompt with available tools information
      let systemPromptWithTools = this.systemPrompt;

      // Add list of available tools if we have any
      const allTools = this.getTools();
      if (allTools.length > 0) {
        systemPromptWithTools += '\n\nDOSTĘPNE NARZĘDZIA:\n';
        for (const tool of allTools) {
          systemPromptWithTools += `\n- ${tool.name}: ${tool.description}`;
          if (tool.inputSchema && typeof tool.inputSchema === 'object') {
            const schema = tool.inputSchema as any;
            if (schema.properties) {
              const params = Object.keys(schema.properties).join(', ');
              systemPromptWithTools += `\n  Parametry: ${params}`;
            }
          }
        }
        systemPromptWithTools += '\n\nUżyj tych narzędzi poprzez format JSON opisany wyżej.';
      }

      // Add system prompt as first message
      const messagesWithSystem = [
        { role: 'system', content: systemPromptWithTools },
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

      // Convert tools to Ollama format (OpenAI-compatible)
      const ollamaTools = allTools.map((tool) => {
        let parameters: any = { type: 'object', properties: {} };

        if (tool.inputSchema && typeof tool.inputSchema === 'object') {
          const schema = tool.inputSchema as any;
          if (schema.type === 'object' && schema.properties) {
            parameters = {
              type: 'object',
              properties: schema.properties,
              required: schema.required || []
            };
          }
        }

        return {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: parameters
          }
        };
      });

      // Call Ollama API with native tool support
      const requestBody: any = {
        model: this.model,
        messages: messagesWithSystem,
        stream: false,
        options: {
          temperature: this.temperature,
          num_predict: this.maxTokens,
        },
      };

      // Add tools if available
      if (ollamaTools.length > 0) {
        requestBody.tools = ollamaTools;
      }

      // Create abort controller with 5 minute timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minutes

      try {
        const response = await fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error (${response.status}): ${errorText}`);
      }

      const data = await response.json() as {
        message?: {
          content?: string,
          tool_calls?: Array<{
            id?: string,
            type?: string,
            function?: {
              name: string,
              arguments: string | Record<string, any>
            }
          }>
        },
        done?: boolean
      };

      const content = data.message?.content || '';

      // Parse tool calls from Ollama's native format (OpenAI-compatible)
      const toolCalls: ToolCall[] = [];

      if (data.message?.tool_calls && Array.isArray(data.message.tool_calls)) {
        for (const call of data.message.tool_calls) {
          if (call.function) {
            // Parse arguments if they're a string
            let args: Record<string, any>;
            if (typeof call.function.arguments === 'string') {
              try {
                args = JSON.parse(call.function.arguments);
              } catch (error) {
                console.warn(`[OllamaAgent] Failed to parse tool arguments:`, error);
                args = {};
              }
            } else {
              args = call.function.arguments || {};
            }

            toolCalls.push({
              id: call.id || `call_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
              name: call.function.name,
              input: args
            });
          }
        }
      }

      // Fallback: also try to parse tool calls from content (for models that don't use native format)
      if (toolCalls.length === 0) {
        const parsedToolCalls = this.parseToolCalls(content);
        toolCalls.push(...parsedToolCalls);
      }

        return {
          content,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          stopReason: data.done ? 'end_turn' : 'max_tokens',
        };
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          throw new Error('Ollama request timeout after 5 minutes. Try simpler query or smaller max_tokens.');
        }
        throw fetchError;
      }
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

      const data = await response.json() as { models?: Array<{ name: string }> };
      return data.models?.map((m) => m.name) || [];
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
