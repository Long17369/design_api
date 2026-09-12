import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/** 与 tsconfig.paths 保持一致（vitest 不走 tsc，需自行声明别名） */
const src = fileURLToPath(new URL('./src', import.meta.url))
const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@core': `${src}/core`,
      '@modules': `${src}/modules`,
      '@gateways': `${src}/gateways`,
      '@root': root,
      '@': src,
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 组件/锁通道为进程级单例，串行执行避免相互干扰
    fileParallelism: false,
  },
})
