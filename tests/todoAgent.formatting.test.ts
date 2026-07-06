import { describe, expect, it } from '@jest/globals';

import { formatDueDateForUser, formatTodoActionPreview } from '../src/todo/todoAgent';

describe('todoAgent formatting', () => {
  it('uses relative wording for today and tomorrow', () => {
    expect(formatDueDateForUser('2026-07-05', '2026-07-05')).toBe("aujourd'hui");
    expect(formatDueDateForUser('2026-07-06', '2026-07-05')).toBe('demain');
  });

  it('does not expose raw ISO dates in add-task confirmation previews', () => {
    const preview = formatTodoActionPreview({
      action: 'add_task',
      title: 'Faire du sport',
      due_date: '2026-07-06',
    });

    expect(preview).toBe("J'ajoute la tache Faire du sport pour demain.");
    expect(preview).not.toContain('2026-07-06');
    expect(preview).not.toContain('prochaine echeance');
  });
});
