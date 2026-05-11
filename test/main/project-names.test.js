import { describe, expect, it } from 'vitest';
import { projectLocationPreview, toProjectDirectoryName } from '../../renderer/src/lib/project-names.js';

describe('project name helpers', () => {
    it('matches the framework directory-safe course name behavior', () => {
        expect(toProjectDirectoryName('CourseCode Demo')).toBe('coursecode_demo');
        expect(toProjectDirectoryName("  Manager's Safety 101!  ")).toBe('managers_safety_101');
        expect(toProjectDirectoryName('Café Basics')).toBe('cafe_basics');
    });

    it('previews the actual directory name the create flow will use', () => {
        expect(projectLocationPreview('/Users/seth/Documents/GitHub', 'CourseCode Demo'))
            .toBe('/Users/seth/Documents/GitHub/coursecode_demo');
    });

    it('uses a placeholder until the display name produces a directory', () => {
        expect(projectLocationPreview('/Users/seth/Documents/GitHub/', '')).toBe('/Users/seth/Documents/GitHub/...');
        expect(projectLocationPreview('/Users/seth/Documents/GitHub/', '!!!')).toBe('/Users/seth/Documents/GitHub/...');
    });
});
