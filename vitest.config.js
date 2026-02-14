import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.js'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'text-summary', 'html', 'lcov'],
            reportsDirectory: './coverage',
            include: ['main/**/*.js'],
            exclude: ['main/index.js'] // App lifecycle — requires real Electron
        }
    }
});
