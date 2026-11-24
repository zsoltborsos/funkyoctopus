import { describe, expect, it } from 'vitest';
import { projectOfTask } from './report-figures.ts';

describe('projectOfTask', () => {
  const projects = ['/home/example/projects/alpha', '/home/example/projects/acme-monorepo'];

  it('names a known project by the last segment of its path', () => {
    expect(projectOfTask('-home-example-projects-alpha:fix-login', projects)).toBe('alpha');
  });

  it('keeps a hyphenated project whole, which the slug alone cannot tell from nested folders', () => {
    expect(projectOfTask('-home-example-projects-acme-monorepo:app-sign-in', projects)).toBe('acme-monorepo');
    // A shorter known path must not claim a longer project's slug.
    expect(projectOfTask('-home-example-projects-acme-monorepo:x', ['/home/example/projects/acme'])).toBe(
      'home-example-projects-acme-monorepo',
    );
  });

  it('shows an unknown project as its slug, less the leading dash', () => {
    expect(projectOfTask('-home-example-code-beta:fix', projects)).toBe('home-example-code-beta');
    expect(projectOfTask('-home-example-code-beta:fix', [])).toBe('home-example-code-beta');
  });

  it('is null when the task id names no project', () => {
    expect(projectOfTask('scope-approval', projects)).toBeNull();
    expect(projectOfTask(':orphan', projects)).toBeNull();
    expect(projectOfTask('-:orphan', projects)).toBeNull();
  });
});
