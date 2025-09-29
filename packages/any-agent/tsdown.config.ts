import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['./src/index.tsx'],
    platform: 'node',
    dts: true,
  },
  {
    entry: ['./src/resumeRunner.ts'],
    platform: 'node',
  },
])
