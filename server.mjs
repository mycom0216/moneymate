// 서버 진입점: .env를 읽고 서비스를 만든 뒤 HTTP 서버를 엽니다.
// 기본은 127.0.0.1(내 PC에서만 접속). 가계부(금융 정보)는 민감하므로 외부 공개를 기본값으로 하지 않습니다.
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, ROOT } from './src/app.mjs';
import { createHandler } from './src/http.mjs';

// 아주 단순한 .env 로더(dotenv 대신). 이미 설정된 환경변수는 덮어쓰지 않습니다.
// .env 파일(있으면)의 KEY=VALUE 줄을 환경변수로 읽어 들입니다. dotenv 패키지 없이 직접 구현해 외부 의존성이 0개입니다.
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/u)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/u.exec(line);
    if (m && !line.trim().startsWith('#') && m[2] && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

// 서비스 생성: DB 파일(data/moneymate.db)을 열고 AI(Ollama 등)에 연결을 시도합니다. AI가 없어도 계속 진행합니다.
const svc = await createApp({ dbPath: join(ROOT, 'data', 'moneymate.db') });
// 기본은 127.0.0.1(내 PC에서만 접속)·포트 5600. 가계부는 금융 정보라 외부 공개를 기본값으로 하지 않습니다(로그인이 없음).
const port = Number(process.env.PORT) || 5600, host = process.env.HOST || '127.0.0.1';
createServer(createHandler(svc)).listen(port, host, () => {
  console.log(`MoneyMate 실행 중: http://${host}:${port}`);
  console.log(`  AI ${svc.llm.label}`);
});
