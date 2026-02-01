#!/usr/bin/env node
import 'dotenv/config';
import * as readline from 'readline';
import { MagenticOrchestrator } from './orchestrator.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║        Magentic Agent Orchestrator - CLI              ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  // Check for API keys
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ Error: ANTHROPIC_API_KEY not found in environment');
    console.error('Please set it in your .env file\n');
    process.exit(1);
  }

  if (!process.env.GOOGLE_API_KEY) {
    console.error('❌ Error: GOOGLE_API_KEY not found in environment');
    console.error('Please set it in your .env file\n');
    process.exit(1);
  }

  // Parse MCP servers from environment
  const mcpServers = process.env.MCP_SERVERS
    ? JSON.parse(process.env.MCP_SERVERS)
    : [];

  console.log('Initializing orchestrator...');
  const orchestrator = new MagenticOrchestrator({
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    googleApiKey: process.env.GOOGLE_API_KEY,
    mcpServers,
  });

  await orchestrator.initialize();
  console.log('✓ Orchestrator initialized\n');

  // Main loop
  let running = true;
  while (running) {
    console.log('\nOptions:');
    console.log('  1. Chat with Claude');
    console.log('  2. Chat with Gemini');
    console.log('  3. Execute task with planning (auto)');
    console.log('  4. Create plan only (no execution)');
    console.log('  5. Exit');

    const choice = await question('\nSelect option (1-5): ');

    switch (choice.trim()) {
      case '1': {
        const message = await question('\nYou (to Claude): ');
        if (message.trim()) {
          console.log('\nClaude is thinking...');
          const response = await orchestrator.chat(message, 'claude');
          console.log('\n' + '─'.repeat(60));
          console.log('Claude:\n');
          console.log(response);
          console.log('─'.repeat(60));
        }
        break;
      }

      case '2': {
        const message = await question('\nYou (to Gemini): ');
        if (message.trim()) {
          console.log('\nGemini is thinking...');
          const response = await orchestrator.chat(message, 'gemini');
          console.log('\n' + '─'.repeat(60));
          console.log('Gemini:\n');
          console.log(response);
          console.log('─'.repeat(60));
        }
        break;
      }

      case '3': {
        const task = await question('\nDescribe your task: ');
        if (task.trim()) {
          console.log('\nExecuting task...');
          const result = await orchestrator.executeTask(task, true);
          console.log('\n' + '═'.repeat(60));
          console.log('Result:\n');
          console.log(result);
          console.log('═'.repeat(60));
        }
        break;
      }

      case '4': {
        const task = await question('\nDescribe your task: ');
        if (task.trim()) {
          console.log('\nCreating plan...');
          const plan = await orchestrator.executeTask(task, false);
          console.log('\n' + '═'.repeat(60));
          console.log('Plan:\n');
          console.log(plan);
          console.log('═'.repeat(60));
        }
        break;
      }

      case '5': {
        console.log('\nCleaning up...');
        await orchestrator.cleanup();
        console.log('✓ Goodbye!\n');
        running = false;
        break;
      }

      default:
        console.log('Invalid option. Please select 1-5.');
    }
  }

  rl.close();
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
