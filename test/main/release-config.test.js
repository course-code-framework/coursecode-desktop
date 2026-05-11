import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '..', '..');

describe('release configuration', () => {
    it('builds a macOS zip package for Electron auto-update', () => {
        const config = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
        const macBlock = config.match(/^mac:\n([\s\S]*?)^win:/m)?.[1] || '';

        expect(macBlock).toContain('target: dmg');
        expect(macBlock).toContain('target: zip');
    });

    it('includes macOS update zips in release checksums', () => {
        const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');

        expect(workflow).toContain('sha256sum *.dmg *.zip *.exe');
    });
});
