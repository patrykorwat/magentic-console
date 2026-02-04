import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { readFileSync } from 'fs';
import {
  Agent,
  AgentConfig,
  AgentResponse,
  Message,
  Tool,
  ToolCall,
  ToolResult,
  MCPServerConfig,
  FileAttachment,
} from '../types/index.js';

export class ClaudeAgent implements Agent {
  name: string;
  capabilities: string[];
  private client: Anthropic;
  private model: string;
  private systemPrompt: string;
  private temperature: number;
  private maxTokens: number;
  private tools: Tool[];
  private mcpClients: Map<string, Client> = new Map();
  private mcpTools: Tool[] = [];

  constructor(
    apiKey: string,
    config: AgentConfig,
    private mcpServers: MCPServerConfig[] = []
  ) {
    console.log(`[ClaudeAgent] Constructor called with ${mcpServers.length} MCP server(s)`);
    if (mcpServers.length > 0) {
      console.log('[ClaudeAgent] MCP servers:', mcpServers.map(s => s.name).join(', '));
    }

    this.client = new Anthropic({ apiKey });
    this.name = config.name;
    this.model = config.model || 'claude-3-7-sonnet-20250219';

    // Default system prompt - universal AI assistant
    const defaultPrompt =
      'Jesteś pomocnym asystentem AI specjalizującym się w głębokim rozumowaniu, analizie kodu i rozwiązywaniu złożonych problemów. ' +
      '\n\nTwoje mocne strony:' +
      '\n• Analiza i generowanie kodu' +
      '\n• Rozwiązywanie problemów technicznych' +
      '\n• Pisanie techniczne i dokumentacja' +
      '\n• Głębokie rozumowanie i logiczne myślenie' +
      '\n\nJeśli masz dostęp do narzędzi MCP, używaj ich aktywnie do wykonywania zadań. ' +
      'Zawsze staraj się dostarczać dokładne, konkretne odpowiedzi oparte na faktach i dostępnych danych.';

    // Use custom prompt if provided, otherwise use systemPrompt or default
    this.systemPrompt = config.customPrompt || config.systemPrompt || defaultPrompt;

    this.temperature = config.temperature ?? 1;
    this.maxTokens = config.maxTokens || 4096;
    this.tools = config.tools || [];
    this.capabilities = [
      'deep_reasoning',
      'code_analysis',
      'code_generation',
      'complex_problem_solving',
      'technical_writing',
    ];
  }

  /**
   * Set the model to use for this agent (allows dynamic model selection per task)
   */
  setModel(model: string): void {
    console.log(`[ClaudeAgent] Changing model from ${this.model} to ${model}`);
    this.model = model;
  }

  /**
   * Get the current model being used
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Initialize MCP servers and load their tools
   */
  async initializeMCP(): Promise<void> {
    console.log(`[ClaudeAgent] Starting MCP initialization with ${this.mcpServers.length} server(s)`);

    for (const serverConfig of this.mcpServers) {
      try {
        console.log(`[ClaudeAgent] Initializing MCP server: ${serverConfig.name}`);
        console.log(`[ClaudeAgent] Command: ${serverConfig.command} ${serverConfig.args.join(' ')}`);

        const transport = new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args,
          env: serverConfig.env,
        });

        console.log(`[ClaudeAgent] Transport created for ${serverConfig.name}`);

        const client = new Client(
          {
            name: `claude-agent-mcp-client-${serverConfig.name}`,
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
          `[ClaudeAgent] Loaded ${mcpTools.length} tools from MCP server: ${serverConfig.name}`
        );
      } catch (error) {
        console.error(
          `[ClaudeAgent] Failed to initialize MCP server ${serverConfig.name}:`,
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
        console.log(`[ClaudeAgent] Closed MCP server: ${name}`);
      } catch (error) {
        console.error(`[ClaudeAgent] Error closing MCP server ${name}:`, error);
      }
    }
    this.mcpClients.clear();
  }

  getTools(): Tool[] {
    return [...this.tools, ...this.mcpTools];
  }

  async executeWithTools(
    messages: Message[],
    toolResults: ToolResult[]
  ): Promise<AgentResponse> {
    // executeWithTools is now just a wrapper - orchestrator builds complete message history
    return this.execute(messages);
  }

  /**
   * Convert file attachment to Claude API document format
   */
  private fileToDocumentBlock(file: FileAttachment): any {
    const fileData = readFileSync(file.path);
    const base64Data = fileData.toString('base64');

    // Determine media type from MIME type
    let mediaType: 'application/pdf' | string = file.mimeType as any;

    return {
      type: 'document',
      source: {
        type: 'base64',
        media_type: mediaType,
        data: base64Data,
      },
    };
  }

  async execute(messages: Message[]): Promise<AgentResponse> {
    const allTools = this.getTools();

    // Convert our message format to Anthropic format, handling file attachments
    const anthropicMessages: Anthropic.MessageParam[] = messages.map((msg) => {
      // If message has files, create content blocks array
      if (msg.files && msg.files.length > 0) {
        const contentBlocks: (Anthropic.TextBlockParam | any)[] = [];

        // Add text content first if it exists and is a string
        if (typeof msg.content === 'string' && msg.content.trim()) {
          contentBlocks.push({
            type: 'text',
            text: msg.content,
          });
        }

        // Add file blocks - PDF as document, others as text
        for (const file of msg.files) {
          console.log(`[ClaudeAgent] Adding file to message: ${file.originalName} (${file.mimeType})`);

          if (file.mimeType === 'application/pdf') {
            // PDF files use document block
            contentBlocks.push(this.fileToDocumentBlock(file));
          } else {
            // Non-PDF files (markdown, txt, etc.) - read as text
            const fileContent = readFileSync(file.path, 'utf-8');
            contentBlocks.push({
              type: 'text',
              text: `--- Zawartość pliku ${file.originalName} ---\n${fileContent}\n--- Koniec pliku ---`,
            });
          }
        }

        return {
          role: msg.role === 'system' ? 'user' : msg.role,
          content: contentBlocks,
        };
      }

      // No files - use content as-is
      return {
        role: msg.role === 'system' ? 'user' : msg.role,
        content: msg.content,
      };
    });

    // Debug: Log the messages structure
    console.log('[ClaudeAgent] Sending messages to API:', JSON.stringify(anthropicMessages.map(m => ({
      role: m.role,
      contentType: Array.isArray(m.content) ? 'array' : typeof m.content,
      contentLength: Array.isArray(m.content) ? m.content.length : 1
    })), null, 2));

    // Convert tools to Anthropic format
    const anthropicTools: Anthropic.Tool[] = allTools.map((tool) => {
      // For Zod schemas, we need to extract the JSON schema representation
      let inputSchema: any;
      if (typeof tool.inputSchema === 'object' && tool.inputSchema !== null) {
        // If it's already a plain object (from MCP), use it directly
        if (!('_def' in tool.inputSchema)) {
          inputSchema = tool.inputSchema;
        } else {
          // For Zod schemas, convert to JSON schema
          inputSchema = zodToJsonSchema(tool.inputSchema, {
            target: 'openApi3',
            $refStrategy: 'none',
          });
        }
      } else {
        inputSchema = { type: 'object' };
      }

      return {
        name: tool.name,
        description: tool.description,
        input_schema: inputSchema,
      };
    });

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        system: this.systemPrompt,
        messages: anthropicMessages,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      });

      // Extract text content
      const textContent = response.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as Anthropic.TextBlock).text)
        .join('\n');

      // Extract tool calls
      const toolCalls: ToolCall[] = response.content
        .filter((block) => block.type === 'tool_use')
        .map((block) => {
          const toolBlock = block as Anthropic.ToolUseBlock;
          return {
            id: toolBlock.id,
            name: toolBlock.name,
            input: toolBlock.input as Record<string, any>,
          };
        });

      return {
        content: textContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        stopReason: response.stop_reason as any,
        rawContent: response.content, // Store raw content for proper message history
      };
    } catch (error: any) {
      // Check if it's a rate limit error
      if (error.status === 429 || error.error?.type === 'rate_limit_error') {
        // Extract retry-after from error or calculate default backoff
        let retryAfterSeconds = 60; // Default 60 seconds

        // Try to parse retry-after from error message or headers
        if (error.headers?.['retry-after']) {
          retryAfterSeconds = parseInt(error.headers['retry-after'], 10);
        } else if (error.error?.message) {
          // Try to extract wait time from error message
          const waitMatch = error.error.message.match(/try again in (\d+) seconds?/i);
          if (waitMatch) {
            retryAfterSeconds = parseInt(waitMatch[1], 10);
          }
        }

        console.log(`[ClaudeAgent] Rate limit hit. Waiting ${retryAfterSeconds} seconds before retry...`);

        // Create a custom error with retry information
        const rateLimitError = new Error(
          `Rate limit przekroczony. Automatyczne ponowienie za ${retryAfterSeconds} sekund...`
        ) as any;
        rateLimitError.isRateLimit = true;
        rateLimitError.retryAfter = retryAfterSeconds;
        rateLimitError.originalError = error;

        throw rateLimitError;
      }

      console.error('[ClaudeAgent] Error executing:', error);
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
      console.error(`[ClaudeAgent] Error calling MCP tool ${toolName}:`, error);
      throw error;
    }
  }
}
