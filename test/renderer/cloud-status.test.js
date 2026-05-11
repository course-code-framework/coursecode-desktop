import { describe, expect, it } from 'vitest';
import { isGithubLinkedStatus } from '../../renderer/src/lib/cloud-status.js';

describe('isGithubLinkedStatus', () => {
    it('detects the legacy source type shape', () => {
        expect(isGithubLinkedStatus({ source: { type: 'github' } })).toBe(true);
        expect(isGithubLinkedStatus({ source_type: 'github' })).toBe(true);
        expect(isGithubLinkedStatus({ sourceType: 'github' })).toBe(true);
    });

    it('detects current Cloud linked repo status', () => {
        expect(isGithubLinkedStatus({
            source_type: 'coursecode',
            github_repo: 'svincent240/coursecode_demo',
            source: {
                type: 'coursecode',
                githubRepo: 'svincent240/coursecode_demo',
                directProductionDeployAllowed: false
            }
        })).toBe(true);
    });

    it('does not mark normal Cloud courses as GitHub-linked', () => {
        expect(isGithubLinkedStatus({
            source_type: 'coursecode',
            github_repo: null,
            source: {
                type: 'coursecode',
                githubRepo: null,
                directProductionDeployAllowed: true
            }
        })).toBe(false);
    });
});
