import Anthropic from '@anthropic-ai/sdk';
import {
  Agent,
  AgentResponse,
  Message,
  Plan,
  PlanStep,
  Tool,
  ToolResult,
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

  constructor(apiKey: string, defaultClaudeModel?: string) {
    this.client = new Anthropic({ apiKey });
    this.name = 'Manager';
    this.model = 'claude-3-7-sonnet-20250219';
    this.defaultClaudeModel = defaultClaudeModel || 'claude-sonnet-4-5-20250929';
    this.capabilities = ['planning', 'orchestration', 'delegation', 'coordination'];
    this.systemPrompt = `Jesteś Agentem Menedżera odpowiedzialnym za planowanie i orkiestrację zadań pomiędzy wyspecjalizowanymi agentami.

Dostępni agenci:
1. Agent Claude - Specjalizuje się w głębokim rozumowaniu, ANALIZIE PLIKÓW PDF, pracy z bazami danych przez MCP, analizie kodu, generowaniu kodu i rozwiązywaniu złożonych problemów. Ma dostęp do narzędzi MCP i może czytać pliki PDF. Używaj do: analizy plików PDF, złożonych operacji z bazą danych przez MCP, złożonej analizy danych, głębokiego rozumowania, zadań wymagających wieloetapowego myślenia.

   Dostępne modele Claude (WAŻNE - wybieraj mądrze ze względu na KOSZTY):
   a) claude-3-5-haiku-20241022 - TANI, szybki model do prostych zadań (analiza tekstu, proste operacje, formatowanie)
   b) claude-3-5-sonnet-20241022 - DROGI, najpotężniejszy model do złożonych zadań (głęboka analiza PDF, skomplikowane zapytania do bazy danych, rozumowanie wieloetapowe)

2. Agent Gemini - Specjalizuje się w wyszukiwaniu w internecie, syntezie informacji TEKSTOWYCH, szybkiej analizie i podsumowywaniu tekstu. NIE MOŻE czytać plików PDF bezpośrednio. Używaj do: podsumowywania TEKSTU (nie plików!), syntezy informacji z poprzednich kroków, wyszukiwania informacji.

WAŻNE ZASADY WYBORU AGENTA I MODELU:
- Jeśli zadanie wymaga CZYTANIA/ANALIZY PLIKÓW PDF → ZAWSZE wybierz Claude
  * Prosta ekstrakcja tekstu z PDF → Haiku (tani)
  * Głęboka analiza zawartości PDF, wyciąganie wniosków → Sonnet (drogi, ale konieczny)
- Jeśli zadanie wymaga OPERACJI Z BAZĄ DANYCH przez MCP → wybierz Claude
  * Proste zapytania (odczyt, podstawowe filtry) → Haiku (tani)
  * Złożone zapytania (wieloetapowe, agregacje, analiza) → Sonnet (drogi)
- Jeśli zadanie wymaga podsumowania TEKSTU z poprzednich kroków → użyj Gemini (najtańszy)
- Gemini NIE MOŻE otrzymywać plików w requiredFiles - tylko Claude!

OPTYMALIZACJA KOSZTÓW - zawsze preferuj tańsze rozwiązania:
1. Gemini > Haiku > Sonnet (od najtańszego do najdroższego)
2. Używaj Sonneta TYLKO gdy zadanie naprawdę wymaga zaawansowanego rozumowania
3. Większość zadań można wykonać Haikuem lub Gemini

Twoje zadania:
1. Analizowanie zapytań użytkownika
2. Tworzenie szczegółowych planów wykonania
3. Delegowanie zadań do najbardziej odpowiedniego agenta
4. Koordynowanie przepływów pracy wielu agentów

Podczas tworzenia planu:
- Rozbij złożone zadania na jasne kroki
- Przypisz każdy krok do najbardziej odpowiedniego agenta (claude, gemini lub manager)
- Podaj uzasadnienie dla każdego przypisania (reasoning musi być PO POLSKU)
- Oszacuj złożoność (low, medium, high)

Jeśli w zadaniu znajdują się załączone pliki, przeanalizuj które pliki są potrzebne w którym kroku i przypisz je używając pola "requiredFiles" (lista nazw plików).

Zwróć plan w formacie JSON:
{
  "goal": "Jasny opis celu",
  "steps": [
    {
      "step": 1,
      "description": "Co należy zrobić",
      "agent": "claude|gemini|manager",
      "model": "claude-3-5-haiku-20241022|claude-3-5-sonnet-20241022", // OPCJONALNE - tylko dla agenta Claude, wybierz mądrze ze względu na koszty!
      "reasoning": "Dlaczego ten agent i model są najlepiej dopasowane - PO POLSKU (wyjaśnij dlaczego Haiku wystarczy lub dlaczego potrzeba Sonneta)",
      "requiredFiles": ["nazwa_pliku.pdf"] // OPCJONALNE - tylko jeśli krok wymaga konkretnych plików
    }
  ],
  "estimatedComplexity": "low|medium|high"
}`;
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
      const response = await fetch('https://api.anthropic.com/v1/models', {
        method: 'GET',
        headers: {
          'x-api-key': this.client.apiKey,
          'anthropic-version': '2023-06-01',
        },
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      this.availableModels = data.data as ClaudeModel[];
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

    // Categorize models by tier (haiku = cheap, sonnet = expensive, opus = very expensive)
    const haikuModels = models.filter(m => m.id.includes('haiku')).slice(0, 2);
    const sonnetModels = models.filter(m => m.id.includes('sonnet')).slice(0, 2);
    const opusModels = models.filter(m => m.id.includes('opus')).slice(0, 1);

    // Get the newest model from each tier (API returns newest first)
    const newestHaiku = haikuModels[0];
    const newestSonnet = sonnetModels[0];
    const newestOpus = opusModels[0];

    let modelsSection = '   Dostępne modele Claude (WAŻNE - wybieraj mądrze ze względu na KOSZTY):\n';

    if (newestHaiku) {
      modelsSection += `   a) ${newestHaiku.id} - TANI, szybki model do prostych zadań (analiza tekstu, proste operacje, formatowanie)\n`;
    }
    if (newestSonnet) {
      modelsSection += `   b) ${newestSonnet.id} - ŚREDNIO DROGI, zbalansowany model do większości zadań (analiza PDF, operacje z bazą danych, rozumowanie)\n`;
    }
    if (newestOpus) {
      modelsSection += `   c) ${newestOpus.id} - BARDZO DROGI, najpotężniejszy model do najtrudniejszych zadań (głęboka analiza, skomplikowane rozumowanie wieloetapowe)\n`;
    }

    // Build model IDs for JSON example
    const modelIds = [newestHaiku?.id, newestSonnet?.id, newestOpus?.id].filter(Boolean).join('|');

    return `Jesteś Agentem Menedżera odpowiedzialnym za planowanie i orkiestrację zadań pomiędzy wyspecjalizowanymi agentami.

Dostępni agenci:
1. Agent Claude - Specjalizuje się w głębokim rozumowaniu, ANALIZIE PLIKÓW PDF, pracy z bazami danych przez MCP, analizie kodu, generowaniu kodu i rozwiązywaniu złożonych problemów. Ma dostęp do narzędzi MCP i może czytać pliki PDF. Używaj do: analizy plików PDF, złożonych operacji z bazą danych przez MCP, złożonej analizy danych, głębokiego rozumowania, zadań wymagających wieloetapowego myślenia.

${modelsSection}
2. Agent Gemini - Specjalizuje się w wyszukiwaniu w internecie, syntezie informacji TEKSTOWYCH, szybkiej analizie i podsumowywaniu tekstu. NIE MOŻE czytać plików PDF bezpośrednio. Używaj do: podsumowywania TEKSTU (nie plików!), syntezy informacji z poprzednich kroków, wyszukiwania informacji.

WAŻNE ZASADY WYBORU AGENTA I MODELU:
- Jeśli zadanie wymaga CZYTANIA/ANALIZY PLIKÓW PDF → ZAWSZE wybierz Claude
  * Prosta ekstrakcja tekstu z PDF → ${newestHaiku?.id || 'Haiku'} (najtańszy)
  * Analiza zawartości PDF, wyciąganie wniosków → ${newestSonnet?.id || 'Sonnet'} (średnio drogi)
  * Głęboka analiza wielu PDF, skomplikowana synteza → ${newestOpus?.id || 'Opus'} (najdroższy, tylko gdy konieczne)
- Jeśli zadanie wymaga OPERACJI Z BAZĄ DANYCH przez MCP → wybierz Claude
  * Proste zapytania (odczyt, podstawowe filtry) → ${newestHaiku?.id || 'Haiku'}
  * Złożone zapytania (wieloetapowe, agregacje, analiza) → ${newestSonnet?.id || 'Sonnet'}
- Jeśli zadanie wymaga podsumowania TEKSTU z poprzednich kroków → użyj Gemini (najtańszy)
- Gemini NIE MOŻE otrzymywać plików w requiredFiles - tylko Claude!

OPTYMALIZACJA KOSZTÓW - zawsze preferuj tańsze rozwiązania:
1. Gemini > ${newestHaiku?.id || 'Haiku'} > ${newestSonnet?.id || 'Sonnet'} ${newestOpus ? `> ${newestOpus.id}` : ''} (od najtańszego do najdroższego)
2. Używaj ${newestSonnet?.id || 'Sonnet'} tylko gdy zadanie wymaga zaawansowanego rozumowania
3. Większość zadań można wykonać ${newestHaiku?.id || 'Haiku'} lub Gemini

Twoje zadania:
1. Analizowanie zapytań użytkownika
2. Tworzenie szczegółowych planów wykonania
3. Delegowanie zadań do najbardziej odpowiedniego agenta
4. Koordynowanie przepływów pracy wielu agentów

Podczas tworzenia planu:
- Rozbij złożone zadania na jasne kroki
- Przypisz każdy krok do najbardziej odpowiedniego agenta (claude, gemini lub manager)
- Podaj uzasadnienie dla każdego przypisania (reasoning musi być PO POLSKU)
- Oszacuj złożoność (low, medium, high)

Jeśli w zadaniu znajdują się załączone pliki, przeanalizuj które pliki są potrzebne w którym kroku i przypisz je używając pola "requiredFiles" (lista nazw plików).

Zwróć plan w formacie JSON:
{
  "goal": "Jasny opis celu",
  "steps": [
    {
      "step": 1,
      "description": "Co należy zrobić",
      "agent": "claude|gemini|manager",
      "model": "${modelIds}", // OPCJONALNE - tylko dla agenta Claude, wybierz najnowszy i najtańszy możliwy model!
      "reasoning": "Dlaczego ten agent i model są najlepiej dopasowane - PO POLSKU (wyjaśnij wybór modelu)",
      "requiredFiles": ["nazwa_pliku.pdf"] // OPCJONALNE - tylko jeśli krok wymaga konkretnych plików
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
    const messages: Message[] = [
      {
        role: 'user',
        content: `Stwórz szczegółowy plan wykonania dla następującego zadania:\n\n${task}\n\nOdpowiedz TYLKO obiektem JSON, bez dodatkowego tekstu. Pamiętaj: pole "reasoning" musi być PO POLSKU.`,
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
