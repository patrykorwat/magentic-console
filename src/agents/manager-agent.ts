import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  Agent,
  AgentResponse,
  Message,
  Plan,
  PlanStep,
  Tool,
  ToolResult,
  MCPServerConfig,
} from '../types/index.js';

interface ClaudeModel {
  id: string;
  display_name: string;
  created_at: string;
  type: string;
}

export class ManagerAgent implements Agent {
  name: string;
  capabilities: string[];
  private client: Anthropic;
  private model: string;
  private defaultClaudeModel: string; // Default model from config for fallback
  private systemPrompt: string;
  private availableModels: ClaudeModel[] = [];
  private modelsLastFetched: number = 0;
  private readonly MODELS_CACHE_TTL = 3600000; // 1 hour in ms
  private mcpClients: Map<string, Client> = new Map();
  private mcpTools: Tool[] = [];

  constructor(
    apiKey: string,
    defaultClaudeModel?: string,
    customPrompt?: string,
    private mcpServers: MCPServerConfig[] = []
  ) {
    this.client = new Anthropic({ apiKey });
    this.name = 'Manager';
    this.model = 'claude-sonnet-4-5-20250929';
    this.defaultClaudeModel = defaultClaudeModel || 'claude-sonnet-4-5-20250929';
    this.capabilities = ['planning', 'orchestration', 'delegation', 'coordination'];

    console.log(`[ManagerAgent] Constructor called with ${this.mcpServers.length} MCP server(s)`);
    if (this.mcpServers.length > 0) {
      console.log('[ManagerAgent] MCP servers:', this.mcpServers.map(s => s.name).join(', '));
    }

    // Use custom prompt from config file, or minimal fallback if config not found
    this.systemPrompt = customPrompt || 'Jesteś Agentem Menedżera. Zwróć plan w formacie JSON z polami: goal, steps (z polami: step, description, agent, model, reasoning, requiredFiles), estimatedComplexity.';
  }

  /**
   * Initialize MCP servers and load their tools
   */
  async initializeMCP(): Promise<void> {
    console.log(`[ManagerAgent] Starting MCP initialization with ${this.mcpServers.length} server(s)`);

    for (const serverConfig of this.mcpServers) {
      try {
        console.log(`[ManagerAgent] Initializing MCP server: ${serverConfig.name}`);
        console.log(`[ManagerAgent] Command: ${serverConfig.command} ${serverConfig.args.join(' ')}`);

        const transport = new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args,
          env: serverConfig.env,
        });

        console.log(`[ManagerAgent] Transport created for ${serverConfig.name}`);

        const client = new Client(
          {
            name: `manager-agent-mcp-client-${serverConfig.name}`,
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
          `[ManagerAgent] Loaded ${mcpTools.length} tools from MCP server: ${serverConfig.name}`
        );
        console.log(`[ManagerAgent] Tool names: ${mcpTools.map(t => t.name).join(', ')}`);
      } catch (error) {
        console.error(
          `[ManagerAgent] Failed to initialize MCP server ${serverConfig.name}:`,
          error
        );
      }
    }
  }

  /**
   * Fetch Neo4j schema summary from MCP (labels and their properties)
   */
  async fetchNeo4jSchema(): Promise<string> {
    if (this.mcpClients.size === 0) {
      console.log('[ManagerAgent] No MCP clients available for schema fetch');
      return '';
    }

    // Look for neo4j MCP client
    const neo4jClient = this.mcpClients.get('neo4j');
    if (!neo4jClient) {
      console.log('[ManagerAgent] No neo4j MCP client found');
      return '';
    }

    try {
      console.log('[ManagerAgent] Fetching Neo4j schema summary via MCP...');

      // Try using get_neo4j_schema tool
      const result = await neo4jClient.callTool({
        name: 'get_neo4j_schema',
        arguments: {},
      });

      // MCP tool result has content array with text items
      if (result.content && Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0] as any;
        const fullSchema = firstContent?.text || '';

        console.log(`[ManagerAgent] Fetched full Neo4j schema (${fullSchema.length} chars)`);

        // Always create ultra-compact summary for small models
        console.log('[ManagerAgent] Creating ultra-compact schema summary...');
        console.log('[ManagerAgent] First 500 chars of full schema:', fullSchema.substring(0, 500));
        const compactSchema = this.extractCompactSchema(fullSchema);
        console.log(`[ManagerAgent] Compact schema (${compactSchema.length} chars):`, compactSchema);

        return compactSchema;
      }

      return '';
    } catch (error) {
      console.error('[ManagerAgent] Error fetching Neo4j schema:', error);
      return '';
    }
  }

  /**
   * Extract ultra-compact schema summary (labels + top 3-5 properties each)
   */
  private extractCompactSchema(fullSchema: string): string {
    try {
      // Neo4j schema is JSON format
      const schema = JSON.parse(fullSchema);

      const MAX_ITEMS = 10;
      const MAX_PROPS = 5;

      let summary = 'Neo4j Schema:\n\n';
      let itemCount = 0;

      // Extract node labels (skip relationships which start with uppercase or have underscores)
      const nodeLabels: string[] = [];
      const relationships: string[] = [];

      for (const [key, value] of Object.entries(schema)) {
        if (itemCount >= MAX_ITEMS * 2) break; // Limit total items

        const item = value as any;

        // Detect if it's a relationship (has type relationship or key is ALL_CAPS_WITH_UNDERSCORES)
        if (item.type === 'relationship' || key.match(/^[A-Z_]+$/)) {
          relationships.push(key);
        } else {
          // It's a node label
          const props = item.properties ? Object.keys(item.properties).slice(0, MAX_PROPS) : [];
          nodeLabels.push(`${key}: ${props.join(', ') || 'no properties'}`);
        }
      }

      // Add node labels
      if (nodeLabels.length > 0) {
        summary += 'Nodes:\n';
        for (const label of nodeLabels.slice(0, MAX_ITEMS)) {
          summary += `- ${label}\n`;
          itemCount++;
        }
      }

      // Add relationships (just names, no properties to save space)
      if (relationships.length > 0 && itemCount < MAX_ITEMS) {
        summary += '\nRelationships: ';
        summary += relationships.slice(0, 5).join(', ');
        summary += '\n';
      }

      return summary.trim();

    } catch (error) {
      console.error('[ManagerAgent] Error parsing JSON schema:', error);
      return `Schema (${fullSchema.length} chars, parse error)`;
    }
  }

  /**
   * Close all MCP connections
   */
  async closeMCP(): Promise<void> {
    for (const [name, client] of this.mcpClients.entries()) {
      try {
        await client.close();
        console.log(`[ManagerAgent] Closed MCP server: ${name}`);
      } catch (error) {
        console.error(`[ManagerAgent] Error closing MCP server ${name}:`, error);
      }
    }
    this.mcpClients.clear();
  }

  /**
   * Load Ollama models configuration from magentic-config.json
   */
  private async loadOllamaModels(): Promise<any[]> {
    const fs = await import('fs/promises');
    const path = await import('path');
    const configPath = path.join(process.cwd(), 'magentic-config.json');

    try {
      const data = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(data);

      if (!config.models || !Array.isArray(config.models)) {
        throw new Error('magentic-config.json: Missing or invalid "models" array');
      }

      if (config.models.length === 0) {
        throw new Error('magentic-config.json: "models" array is empty');
      }

      // Validate each model has required fields
      for (const model of config.models) {
        if (!model.id) {
          throw new Error(`magentic-config.json: Model missing "id" field: ${JSON.stringify(model)}`);
        }
      }

      return config.models;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new Error(`magentic-config.json not found at: ${configPath}`);
      }
      if (error instanceof SyntaxError) {
        throw new Error(`magentic-config.json contains invalid JSON: ${error.message}`);
      }
      throw error; // Re-throw validation errors and other errors
    }
  }

  /**
   * Fetch available Claude models from API (with caching)
   */
  private async fetchAvailableModels(): Promise<ClaudeModel[]> {
    const now = Date.now();

    // Return cached models if still fresh
    if (this.availableModels.length > 0 && (now - this.modelsLastFetched) < this.MODELS_CACHE_TTL) {
      console.log('[ManagerAgent] Using cached models list');
      return this.availableModels;
    }

    try {
      console.log('[ManagerAgent] Fetching available models from API...');

      // Use direct fetch since SDK version doesn't have models.list()
      const apiKey = this.client.apiKey;
      if (!apiKey) {
        throw new Error('API key is not available');
      }

      const response = await fetch('https://api.anthropic.com/v1/models', {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as { data: ClaudeModel[] };
      this.availableModels = data.data;
      this.modelsLastFetched = now;

      console.log(`[ManagerAgent] Fetched ${this.availableModels.length} models from API`);
      this.availableModels.slice(0, 5).forEach(m => {
        console.log(`  - ${m.id} (${m.display_name})`);
      });

      return this.availableModels;
    } catch (error) {
      console.error('[ManagerAgent] Error fetching models from API:', error);
      // Return fallback with default model from config
      const fallback = [
        { id: this.defaultClaudeModel, display_name: 'Claude (Default from Config)', created_at: new Date().toISOString(), type: 'model' }
      ];
      console.log('[ManagerAgent] Using fallback with default model from config:', this.defaultClaudeModel);
      return fallback;
    }
  }

  /**
   * Generate dynamic system prompt with available models
   */
  private async getDynamicSystemPrompt(): Promise<string> {
    const models = await this.fetchAvailableModels();
    const ollamaModels = await this.loadOllamaModels();

    // Categorize Claude models by tier
    const haikuModels = models.filter(m => m.id.includes('haiku')).slice(0, 2);
    const sonnetModels = models.filter(m => m.id.includes('sonnet')).slice(0, 2);
    const opusModels = models.filter(m => m.id.includes('opus')).slice(0, 1);

    const newestHaiku = haikuModels[0];
    const newestSonnet = sonnetModels[0];
    const newestOpus = opusModels[0];

    // Build Claude models section
    let claudeModelsSection = '   Dostępne modele Claude (WAŻNE - wybieraj mądrze ze względu na KOSZTY):\n';

    if (newestHaiku) {
      claudeModelsSection += `   a) ${newestHaiku.id} - TANI, szybki model do prostych zadań (analiza tekstu, proste operacje, formatowanie)\n`;
    }
    if (newestSonnet) {
      claudeModelsSection += `   b) ${newestSonnet.id} - ŚREDNIO DROGI, zbalansowany model do większości zadań (analiza PDF, operacje z bazą danych, rozumowanie)\n`;
    }
    if (newestOpus) {
      claudeModelsSection += `   c) ${newestOpus.id} - BARDZO DROGI, najpotężniejszy model do najtrudniejszych zadań (głęboka analiza, skomplikowane rozumowanie wieloetapowe)\n`;
    }

    // Build Ollama models section
    let ollamaModelsSection = '   Dostępne modele Ollama (DARMOWE - wybieraj według możliwości modelu):\n';
    const recommendedOllama = ollamaModels.find(m => m.recommended);
    const otherOllama = ollamaModels.filter(m => !m.recommended).slice(0, 3);

    if (recommendedOllama) {
      ollamaModelsSection += `   * ${recommendedOllama.id} - ${recommendedOllama.description} (REKOMENDOWANY)\n`;
    }
    otherOllama.forEach((model, idx) => {
      ollamaModelsSection += `   * ${model.id} - ${model.description}\n`;
    });

    // Build model IDs for JSON example
    const claudeModelIds = [newestHaiku?.id, newestSonnet?.id, newestOpus?.id].filter(Boolean).join('|');
    const ollamaModelIds = ollamaModels.map(m => m.id).slice(0, 3).join('|');

    return `Jesteś Agentem Menedżera odpowiedzialnym za planowanie i orkiestrację zadań pomiędzy wyspecjalizowanymi agentami.

Dostępni agenci:
1. Agent Claude - Specjalizuje się w głębokim rozumowaniu, ANALIZIE PLIKÓW PDF, pracy z bazami danych przez MCP, analizie kodu, generowaniu kodu i rozwiązywaniu złożonych problemów. Ma dostęp do narzędzi MCP i może czytać pliki PDF. PŁATNY ($). Używaj do: analizy plików PDF, złożonych operacji z bazą danych przez MCP, złożonej analizy danych, głębokiego rozumowania, zadań wymagających wieloetapowego myślenia.

${claudeModelsSection}

2. Agent Gemini - Specjalizuje się w wyszukiwaniu w internecie, syntezie informacji TEKSTOWYCH, szybkiej analizie i podsumowywaniu tekstu. NIE MOŻE czytać plików PDF bezpośrednio. PŁATNY ($). Używaj do: podsumowywania TEKSTU (nie plików!), syntezy informacji z poprzednich kroków, wyszukiwania informacji.

3. Agent Ollama - Lokalny model open-source działający OFFLINE. DARMOWY, ale słabszy od Claude/Gemini. Ma dostęp do narzędzi MCP (jak Claude). RÓŻNE MODELE mają różne możliwości - wybieraj według zadania.

${ollamaModelsSection}

4. Agent MLX - Lokalny model zoptymalizowany dla Apple Silicon (M1/M2/M3/M4/M5) z akceleratorami neuronowymi. DARMOWY, działa OFFLINE z najwyższą wydajnością na Mac. MA PEŁNY DOSTĘP DO NARZĘDZI MCP. Używaj gdy użytkownik ma Apple Silicon i potrzebuje najszybszego lokalnego rozumowania.

   Dostępne modele MLX (DARMOWE - zoptymalizowane dla Apple Silicon):
   * mlx-community/Llama-3.2-3B-Instruct-4bit - Szybki model 3B (REKOMENDOWANY dla większości zadań)
   * mlx-community/Qwen2.5-7B-Instruct-4bit - Mocniejszy model 7B
   * mlx-community/Mistral-7B-Instruct-v0.3-4bit - Silny w rozumowaniu logicznym

WAŻNE ZASADY WYBORU AGENTA I MODELU:
- Jeśli zadanie wymaga CZYTANIA/ANALIZY PLIKÓW PDF → ZAWSZE wybierz Claude (tylko Claude obsługuje PDF)
  * Prosta ekstrakcja tekstu z PDF → ${newestHaiku?.id || 'Haiku'} (najtańszy)
  * Analiza zawartości PDF, wyciąganie wniosków → ${newestSonnet?.id || 'Sonnet'} (średnio drogi)
  * Głęboka analiza wielu PDF, skomplikowana synteza → ${newestOpus?.id || 'Opus'} (najdroższy, tylko gdy konieczne)
- Jeśli zadanie wymaga OPERACJI Z BAZĄ DANYCH przez MCP → wybierz Claude, MLX LUB Ollama (wszystkie mają MCP)
  * Bardzo proste zapytania (pojedyncze rekordy, podstawowy odczyt) → MLX lub Ollama (DARMOWE, lokalne!)
  * Średnio złożone (podstawowe filtry, proste agregacje) → MLX (najszybszy na Apple Silicon) lub ${newestHaiku?.id || 'Haiku'} (tani)
  * Złożone zapytania (wieloetapowe, agregacje, analiza) → ${newestSonnet?.id || 'Sonnet'} (drogi)
- Jeśli zadanie wymaga PROSTEJ analizy tekstu BEZ złożonego rozumowania → użyj MLX lub Ollama (darmowe, lokalne)
- Jeśli zadanie wymaga KODOWANIA → MLX, Ollama z ${ollamaModels.find(m => m.id.includes('coder'))?.id || 'qwen2.5-coder:7b'} LUB Claude
- Jeśli zadanie wymaga podsumowania TEKSTU z poprzednich kroków → użyj Gemini, MLX lub Ollama (tanie/darmowe opcje)
- Jeśli użytkownik ma Apple Silicon (Mac M1/M2/M3/M4/M5) → preferuj MLX dla najlepszej wydajności lokalnej
- Gemini, Ollama i MLX NIE MOGĄ otrzymywać plików w requiredFiles - tylko Claude!

OPTYMALIZACJA KOSZTÓW - zawsze preferuj tańsze rozwiązania:
1. MLX (DARMOWY, najszybszy na Apple Silicon) = Ollama (DARMOWY) > Gemini > ${newestHaiku?.id || 'Haiku'} > ${newestSonnet?.id || 'Sonnet'} ${newestOpus ? `> ${newestOpus.id}` : ''} (od najtańszego do najdroższego)
2. Używaj ${newestSonnet?.id || 'Sonnet'} tylko gdy zadanie naprawdę wymaga zaawansowanego rozumowania
3. Większość prostych zadań można wykonać MLX lub Ollama (lokalne, darmowe)
4. Używaj Gemini/${newestHaiku?.id || 'Haiku'} gdy MLX/Ollama nie wystarczają
5. Na Apple Silicon (Mac M-series) preferuj MLX dla najlepszej wydajności

Twoje zadania:
1. Analizowanie zapytań użytkownika
2. Tworzenie szczegółowych planów wykonania
3. Delegowanie zadań do najbardziej odpowiedniego agenta
4. Koordynowanie przepływów pracy wielu agentów

Podczas tworzenia planu:
- Rozbij złożone zadania na jasne kroki
- Przypisz każdy krok do najbardziej odpowiedniego agenta (claude, gemini, ollama, mlx lub manager)
- Podaj uzasadnienie dla każdego przypisania (reasoning musi być PO POLSKU)
- Oszacuj złożoność (low, medium, high)

WAŻNE - LIMITY WYNIKÓW NARZĘDZI MCP:
- Gdy Claude/Ollama/MLX używa narzędzi MCP (bazy danych), wyniki są automatycznie skracane do 10,000 znaków aby nie przekroczyć limitu kontekstu
- W opisie zadania dla Claude/Ollama/MLX ZAWSZE dodaj instrukcję: "Używaj precyzyjnych zapytań z filtrami (WHERE, LIMIT). Pobieraj tylko niezbędne dane, nie całą bazę."
- Jeśli zadanie wymaga analizy dużej ilości danych, podziel je na mniejsze kroki z konkretnymi filtrami/limitami
- Przykład DOBRY: "Znajdź top 10 rekordów spełniających warunek X (użyj WHERE, ORDER BY, LIMIT 10)"
- Przykład ZŁY: "Pobierz wszystkie rekordy z bazy" (może zwrócić tysiące rekordów i przekroczyć limit kontekstu)

Jeśli w zadaniu znajdują się załączone pliki, przeanalizuj które pliki są potrzebne w którym kroku i przypisz je używając pola "requiredFiles" (lista nazw plików).

Zwróć plan w formacie JSON:
{
  "goal": "Jasny opis celu",
  "steps": [
    {
      "step": 1,
      "description": "Co należy zrobić",
      "agent": "claude|gemini|ollama|mlx|manager",
      "model": "${claudeModelIds || 'claude'}|${ollamaModelIds || 'ollama'}|mlx-community/Llama-3.2-3B-Instruct-4bit|mlx-community/Qwen2.5-7B-Instruct-4bit|mlx-community/Mistral-7B-Instruct-v0.3-4bit", // OPCJONALNE - dla Claude/Ollama/MLX, wybierz najbardziej odpowiedni model!
      "reasoning": "Dlaczego ten agent i model są najlepiej dopasowane - PO POLSKU (wyjaśnij wybór agenta i modelu, np: Ollama ${recommendedOllama?.id || 'qwen2.5:7b'} dla prostego zapytania do bazy, ${newestSonnet?.id || 'Sonnet'} dla złożonej analizy)",
      "requiredFiles": ["nazwa_pliku.pdf"] // OPCJONALNE - tylko jeśli krok wymaga konkretnych plików (tylko Claude!)
    }
  ],
  "estimatedComplexity": "low|medium|high"
}`;
  }

  getTools(): Tool[] {
    return [];
  }

  async execute(messages: Message[]): Promise<AgentResponse> {
    return this.executeWithTools(messages, []);
  }

  async executeWithTools(
    messages: Message[],
    toolResults: ToolResult[]
  ): Promise<AgentResponse> {
    const anthropicMessages: Anthropic.MessageParam[] = messages.map((msg) => ({
      role: msg.role === 'system' ? 'user' : msg.role,
      content: msg.content,
    }));

    try {
      // Get dynamic system prompt with latest available models
      const dynamicPrompt = await this.getDynamicSystemPrompt();

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        temperature: 0.7,
        system: dynamicPrompt,
        messages: anthropicMessages,
      });

      const textContent = response.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as Anthropic.TextBlock).text)
        .join('\n');

      return {
        content: textContent,
        stopReason: response.stop_reason as any,
      };
    } catch (error) {
      console.error('[ManagerAgent] Error executing:', error);
      throw error;
    }
  }

  /**
   * Create a plan for a given task
   */
  async createPlan(task: string): Promise<Plan> {
    // Fetch Neo4j schema if available and task involves Neo4j/database
    let schemaContext = '';
    let compactSchema = '';
    if (task.toLowerCase().includes('neo4j') || task.toLowerCase().includes('graf') || task.toLowerCase().includes('baz') || task.toLowerCase().includes('cypher')) {
      console.log('[ManagerAgent] Task involves Neo4j - fetching schema...');
      const schema = await this.fetchNeo4jSchema();
      if (schema) {
        compactSchema = schema; // Save for later use in step descriptions
        schemaContext = `\n\n🗄️ RZECZYWISTY SCHEMAT NEO4J:\n${schema}\n\n⚠️ WAŻNE: Używaj TYLKO tych etykiet, właściwości i relacji które są w powyższym schemacie! NIE WYMYŚLAJ własnych etykiet jak "Person", "Politician" itp.`;
      }
    }

    const messages: Message[] = [
      {
        role: 'user',
        content: `Stwórz szczegółowy plan wykonania dla następującego zadania:\n\n${task}${schemaContext}\n\nOdpowiedz TYLKO obiektem JSON, bez dodatkowego tekstu. Pamiętaj: pole "reasoning" musi być PO POLSKU.`,
      },
    ];

    const response = await this.execute(messages);

    try {
      // Extract JSON from the response
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const plan: Plan = JSON.parse(jsonMatch[0]);

      // Add compact schema to Ollama/Bielik step descriptions (not to Claude - it has MCP access)
      if (compactSchema) {
        for (const step of plan.steps) {
          if (step.agent === 'ollama') {
            step.description = `${step.description}\n\n📋 SCHEMAT NEO4J:\n${compactSchema}\n\n⚠️ NIE UŻYWAJ narzędzia 'get_neo4j_schema' - schemat jest już powyżej! Używaj TYLKO 'read_neo4j_cypher' lub 'write_neo4j_cypher'.`;
          }
        }
      }

      return plan;
    } catch (error) {
      console.error('[ManagerAgent] Error parsing plan:', error);
      console.error('Response:', response.content);

      // Return a fallback plan
      return {
        goal: task,
        steps: [
          {
            step: 1,
            description: task,
            agent: 'claude',
            reasoning: 'Domyślnie używam agenta Claude z powodu błędu parsowania',
          },
        ],
        estimatedComplexity: 'medium',
      };
    }
  }

  /**
   * Evaluate which agent should handle a specific task
   */
  async selectAgent(task: string): Promise<'claude' | 'gemini'> {
    const messages: Message[] = [
      {
        role: 'user',
        content: `Który agent powinien obsłużyć to zadanie? Odpowiedz tylko "claude" lub "gemini".\n\nZadanie: ${task}`,
      },
    ];

    const response = await this.execute(messages);
    const selection = response.content.toLowerCase().trim();

    if (selection.includes('gemini')) {
      return 'gemini';
    }
    return 'claude';
  }
}
