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
  MCPServerConfig,
} from '../types/index.js';
import { getMLXDefaultPrompt } from './prompts.js';

export class MLXAgent implements Agent {
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
    console.log(`[MLXAgent] Constructor called with ${mcpServers.length} MCP server(s)`);
    if (mcpServers.length > 0) {
      console.log('[MLXAgent] MCP servers:', mcpServers.map(s => s.name).join(', '));
    }

    this.name = config.name;
    this.baseUrl = baseUrl || 'http://localhost:8080';
    this.model = config.model || 'mlx-community/Llama-3.2-3B-Instruct-4bit';

    // Use custom prompt if provided, otherwise use systemPrompt or default from prompts config
    this.systemPrompt = config.customPrompt || config.systemPrompt || getMLXDefaultPrompt();

    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = config.maxTokens || 4096;
    this.tools = config.tools || [];
    this.capabilities = [
      'local_inference',
      'privacy_focused',
      'offline_capable',
      'apple_silicon_optimized',
      'neural_accelerator',
      'cost_free',
      'mcp_tools',
    ];
  }

  /**
   * Initialize MCP servers and load their tools
   */
  async initializeMCP(): Promise<void> {
    console.log(`[MLXAgent] Starting MCP initialization with ${this.mcpServers.length} server(s)`);

    for (const serverConfig of this.mcpServers) {
      try {
        console.log(`[MLXAgent] Initializing MCP server: ${serverConfig.name}`);
        console.log(`[MLXAgent] Command: ${serverConfig.command} ${serverConfig.args.join(' ')}`);

        const transport = new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args,
          env: serverConfig.env,
        });

        console.log(`[MLXAgent] Transport created for ${serverConfig.name}`);

        const client = new Client(
          {
            name: `mlx-agent-mcp-client-${serverConfig.name}`,
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
          `[MLXAgent] Loaded ${mcpTools.length} tools from MCP server: ${serverConfig.name}`
        );
      } catch (error) {
        console.error(
          `[MLXAgent] Failed to initialize MCP server ${serverConfig.name}:`,
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
        console.log(`[MLXAgent] Closed MCP server: ${name}`);
      } catch (error) {
        console.error(`[MLXAgent] Error closing MCP server ${name}:`, error);
      }
    }
    this.mcpClients.clear();
  }

  getTools(): Tool[] {
    return [...this.tools, ...this.mcpTools];
  }

  /**
   * Parse tool calls from MLX response content
   * Looks for JSON blocks with tool_calls array
   */
  private parseToolCalls(content: string): ToolCall[] {
    const toolCalls: ToolCall[] = [];

    // Format 1: Try to parse XML <tool_call> tags
    const xmlToolCallRegex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
    let xmlMatch;

    while ((xmlMatch = xmlToolCallRegex.exec(content)) !== null) {
      try {
        const jsonContent = xmlMatch[1];
        console.log(`[MLXAgent] Raw XML tool call JSON: ${jsonContent}`);
        const parsed = JSON.parse(jsonContent);

        if (parsed.name && (parsed.arguments || parsed.input || parsed.parameters)) {
          toolCalls.push({
            id: parsed.id || `call_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
            name: parsed.name,
            input: parsed.arguments || parsed.input || parsed.parameters
          });
          console.log(`[MLXAgent] Parsed XML tool call: ${parsed.name}`);
        }
      } catch (error) {
        console.warn('[MLXAgent] Failed to parse XML tool call:', error);
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
        console.warn('[MLXAgent] Failed to parse JSON block:', error);
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
      // Build MLX-compatible messages (OpenAI format)
      const mlxMessages = messages.map((msg) => {
        let content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

        // Add file information if present
        if (msg.files && msg.files.length > 0) {
          const fileContext = msg.files
            .map((f) => `\n[File: ${f.originalName} (${f.mimeType})]`)
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
        systemPromptWithTools += '\n\nAVAILABLE TOOLS:\n';
        for (const tool of allTools) {
          systemPromptWithTools += `\n- ${tool.name}: ${tool.description}`;
          if (tool.inputSchema && typeof tool.inputSchema === 'object') {
            const schema = tool.inputSchema as any;
            if (schema.properties) {
              const params = Object.keys(schema.properties).join(', ');
              systemPromptWithTools += `\n  Parameters: ${params}`;
            }
          }
        }
        systemPromptWithTools += '\n\nUse these tools via the JSON format described above.';
      }

      // Add system prompt as first message
      const messagesWithSystem = [
        { role: 'system', content: systemPromptWithTools },
        ...mlxMessages,
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

      // Convert tools to OpenAI format (MLX server uses OpenAI-compatible format)
      const mlxTools = allTools.map((tool) => {
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

      // Call MLX API with OpenAI-compatible format
      const requestBody: any = {
        model: this.model,
        messages: messagesWithSystem,
        stream: false,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
      };

      // NOTE: Do NOT add tools parameter - MLX doesn't support native tool calling
      // Tools are already described in the system prompt (line 272-284)
      // Model will generate tool calls in text format which we parse later

      // Create abort controller with 5 minute timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minutes

      try {
        const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
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
          throw new Error(`MLX API error (${response.status}): ${errorText}`);
        }

        const data = await response.json() as {
          id?: string,
          choices?: Array<{
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
            finish_reason?: string
          }>,
          usage?: any
        };

        const choice = data.choices?.[0];
        const content = choice?.message?.content || '';

        // Parse tool calls from MLX's OpenAI-compatible format
        const toolCalls: ToolCall[] = [];

        if (choice?.message?.tool_calls && Array.isArray(choice.message.tool_calls)) {
          for (const call of choice.message.tool_calls) {
            if (call.function) {
              // Parse arguments if they're a string
              let args: Record<string, any>;
              if (typeof call.function.arguments === 'string') {
                try {
                  args = JSON.parse(call.function.arguments);
                } catch (error) {
                  console.warn(`[MLXAgent] Failed to parse tool arguments:`, error);
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
          stopReason: choice?.finish_reason === 'stop' ? 'end_turn' : 'max_tokens',
        };
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          throw new Error('MLX request timeout after 5 minutes. Try simpler query or smaller max_tokens.');
        }
        throw fetchError;
      }
    } catch (error) {
      console.error('[MLXAgent] Error executing:', error);

      // Provide helpful error messages
      if (error instanceof Error) {
        if (error.message.includes('ECONNREFUSED')) {
          throw new Error(
            'Cannot connect to MLX server. Make sure the MLX server is running (mlx_lm.server).'
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
      console.error(`[MLXAgent] Error calling MCP tool ${toolName}:`, error);
      throw error;
    }
  }

  /**
   * Check if MLX server is available and running
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
      });
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get list of available models from MLX server
   */
  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json() as { data?: Array<{ id: string }> };
      return data.data?.map((m) => m.id) || [];
    } catch (error) {
      console.error('[MLXAgent] Error listing models:', error);
      return [];
    }
  }

  /**
   * Set the model to use for this agent
   */
  setModel(model: string): void {
    console.log(`[MLXAgent] Changing model from ${this.model} to ${model}`);
    this.model = model;
  }

  /**
   * Get the current model being used
   */
  getModel(): string {
    return this.model;
  }
}
