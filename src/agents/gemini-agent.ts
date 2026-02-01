import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { readFileSync } from 'fs';
import {
  Agent,
  AgentConfig,
  AgentResponse,
  Message,
  Tool,
  ToolCall,
  ToolResult,
  FileAttachment,
} from '../types/index.js';

export class GeminiAgent implements Agent {
  name: string;
  capabilities: string[];
  private client: GoogleGenerativeAI;
  private model: GenerativeModel;
  private modelName: string;
  private systemPrompt: string;
  private temperature: number;
  private maxTokens: number;
  private tools: Tool[];

  constructor(apiKey: string, config: AgentConfig) {
    this.client = new GoogleGenerativeAI(apiKey);
    this.name = config.name;
    this.modelName = config.model || 'gemini-2.0-flash-exp';

    // Default system prompt
    const defaultPrompt =
      'Jesteś pomocnym asystentem AI specjalizującym się w wyszukiwaniu informacji i podsumowywaniu. Wyróżniasz się w znajdowaniu informacji, syntetyzowaniu wielu źródeł i dostarczaniu zwięzłych podsumowań.';

    // Use custom prompt if provided, otherwise use systemPrompt or default
    this.systemPrompt = config.customPrompt || config.systemPrompt || defaultPrompt;

    this.temperature = config.temperature ?? 1;
    this.maxTokens = config.maxTokens || 4096;
    this.tools = config.tools || [];
    this.capabilities = [
      'web_search',
      'summarization',
      'information_retrieval',
      'data_synthesis',
      'quick_analysis',
    ];

    // Initialize model with configuration
    this.model = this.client.getGenerativeModel({
      model: this.modelName,
      systemInstruction: this.systemPrompt,
      generationConfig: {
        temperature: this.temperature,
        maxOutputTokens: this.maxTokens,
      },
    });
  }

  getTools(): Tool[] {
    return this.tools;
  }

  /**
   * Convert file attachment to Gemini API inlineData format
   */
  private fileToInlineData(file: FileAttachment): any {
    const fileData = readFileSync(file.path);
    const base64Data = fileData.toString('base64');

    return {
      inlineData: {
        mimeType: file.mimeType,
        data: base64Data,
      },
    };
  }

  async execute(messages: Message[]): Promise<AgentResponse> {
    return this.executeWithTools(messages, []);
  }

  async executeWithTools(
    messages: Message[],
    toolResults: ToolResult[]
  ): Promise<AgentResponse> {
    try {
      // Convert our message format to Gemini format, handling file attachments
      const geminiMessages = messages
        .filter((msg) => msg.role !== 'system')
        .map((msg) => {
          const parts: any[] = [];

          // Add text content if exists
          if (typeof msg.content === 'string' && msg.content.trim()) {
            parts.push({ text: msg.content });
          } else if (typeof msg.content !== 'string') {
            parts.push({ text: JSON.stringify(msg.content) });
          }

          // Add file attachments if exist
          if (msg.files && msg.files.length > 0) {
            for (const file of msg.files) {
              console.log(`[GeminiAgent] Adding file to message: ${file.originalName} (${file.mimeType})`);
              parts.push(this.fileToInlineData(file));
            }
          }

          return {
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts,
          };
        });

      // Start chat session
      const chat = this.model.startChat({
        history: geminiMessages.slice(0, -1),
        generationConfig: {
          temperature: this.temperature,
          maxOutputTokens: this.maxTokens,
        },
      });

      // Send message with parts (text + files)
      // Gemini API supports multiple parts including inlineData for files
      const lastMessage = geminiMessages[geminiMessages.length - 1];
      const result = await chat.sendMessage(lastMessage.parts);

      const response = result.response;

      // Note: Function calling support would be added here when available
      // For now, Gemini works without explicit tool definitions
      return {
        content: response.text(),
        stopReason: 'end_turn',
      };
    } catch (error) {
      console.error('[GeminiAgent] Error executing:', error);
      throw error;
    }
  }

  /**
   * Convert Zod schema to Gemini parameter schema
   * Note: This is a simplified conversion. You may need to enhance it for complex schemas.
   */
  private zodToGeminiSchema(zodSchema: any): any {
    // If the schema has a _def property, try to extract the shape
    if (zodSchema._def) {
      const typeName = zodSchema._def.typeName;

      if (typeName === 'ZodObject') {
        const shape = zodSchema._def.shape();
        const properties: any = {};
        const required: string[] = [];

        for (const [key, value] of Object.entries(shape)) {
          properties[key] = this.zodToGeminiSchema(value);
          // Check if field is required (not optional)
          if (!(value as any).isOptional?.()) {
            required.push(key);
          }
        }

        return {
          type: 'object',
          properties,
          required: required.length > 0 ? required : undefined,
        };
      } else if (typeName === 'ZodString') {
        return { type: 'string' };
      } else if (typeName === 'ZodNumber') {
        return { type: 'number' };
      } else if (typeName === 'ZodBoolean') {
        return { type: 'boolean' };
      } else if (typeName === 'ZodArray') {
        return {
          type: 'array',
          items: this.zodToGeminiSchema(zodSchema._def.type),
        };
      }
    }

    // Fallback to a generic object type
    return { type: 'string' };
  }
}
