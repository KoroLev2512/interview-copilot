import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['electron/**/*.test.ts', 'shared/**/*.test.ts'],
    environment: 'node',
    // Тесты сами выставляют CHUNK_SECONDS / OPENAI_API_KEY через vi.stubEnv.
    unstubEnvs: true,
    restoreMocks: true
  }
})
