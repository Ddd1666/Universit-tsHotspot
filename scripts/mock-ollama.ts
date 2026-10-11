// Eigenständiger Mock-Ollama (nur Tests/Demo): `npm run mock-ollama` -> http://127.0.0.1:11435
import { startMockOllama } from '../server/ollama/mock.ts';

const port = Number(process.env.MOCK_OLLAMA_PORT ?? 11435);
const mock = await startMockOllama({ port });
console.log(`Mock-Ollama läuft auf ${mock.url} (KEIN echtes Modell – nur für Tests)`);
process.on('SIGINT', () => void mock.close().then(() => process.exit(0)));
