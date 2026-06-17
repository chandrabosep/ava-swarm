// Singleton Prisma client. Each agent process boots one of these.
//
// Run `npm run prisma:generate` (in agents/) once after schema changes to
// regenerate the typed client; otherwise the import below errors.

import { PrismaClient } from '@prisma/client';

let _prisma: PrismaClient | undefined;

export function db(): PrismaClient {
  if (!_prisma) {
    _prisma = new PrismaClient({
      log:
        process.env.PRISMA_LOG === '1'
          ? ['query', 'warn', 'error']
          : ['warn', 'error'],
    });
  }
  return _prisma;
}

export async function disconnectDb(): Promise<void> {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = undefined;
  }
}

// Re-export types from the generated client so agent code imports from
// `@swarm/shared` and doesn't need a direct @prisma/client dep.
export type {
  User,
  Session,
  Intent,
  Event as DbEvent,
  AgentState,
  AgentRole,
  IntentStatus,
} from '@prisma/client';
