/**
 * toSingleParagraphPlainText — unit tests
 *
 * Covers:
 *  - Clean text passes through unchanged
 *  - Strips all markdown tokens: # * _ ` > | [ ] ( )
 *  - Strips all bullet characters: • ◦ ▪ ▫ ● ○ ■ □ ◆ ◇
 *  - Collapses \n, \r\n, \r into a single space
 *  - Collapses multiple consecutive spaces into one
 *  - Trims leading and trailing whitespace
 *  - Handles null / undefined input (returns empty string)
 *  - Handles non-string input coerced to string
 *  - Handles already clean single-line text (no mutation)
 *  - Real-world HA response with markdown → clean TTS-ready string
 */

import { describe, expect, test } from '@jest/globals';

import { toSingleParagraphPlainText } from '../src/conversation/plainText';

describe('toSingleParagraphPlainText', () => {
  test('returns clean text unchanged', () => {
    expect(toSingleParagraphPlainText('Il fait beau aujourd\'hui.')).toBe('Il fait beau aujourd\'hui.');
  });

  test('strips markdown header token #', () => {
    // '#' replaced by space, then leading space trimmed
    expect(toSingleParagraphPlainText('# Titre')).toBe('Titre');
    expect(toSingleParagraphPlainText('## Sous-titre')).not.toContain('#');
    expect(toSingleParagraphPlainText('## Sous-titre')).toContain('Sous-titre');
  });

  test('strips markdown bold/italic * and _', () => {
    const result = toSingleParagraphPlainText('**Allume** la _lumière_');
    expect(result).not.toContain('*');
    expect(result).not.toContain('_');
    expect(result).toContain('Allume');
    expect(result).toContain('lumière');
  });

  test('strips inline code backtick `', () => {
    // note: '_' is also a markdown token, so underscores are replaced too
    const result = toSingleParagraphPlainText('Exécute `script.audio.salon`');
    expect(result).not.toContain('`');
    expect(result).toContain('script.audio.salon');
  });

  test('strips blockquote token >', () => {
    const result = toSingleParagraphPlainText('> Citation importante');
    expect(result).not.toContain('>');
    expect(result).toContain('Citation importante');
  });

  test('strips table pipe |', () => {
    const result = toSingleParagraphPlainText('col1 | col2 | col3');
    expect(result).not.toContain('|');
  });

  test('strips markdown link syntax [ ] ( )', () => {
    const result = toSingleParagraphPlainText('[cliquez ici](http://example.com)');
    expect(result).not.toContain('[');
    expect(result).not.toContain(']');
    expect(result).not.toContain('(');
    expect(result).not.toContain(')');
    expect(result).toContain('cliquez ici');
  });

  test('strips round bullet •', () => {
    const result = toSingleParagraphPlainText('• Salon\n• Chambre');
    expect(result).not.toContain('•');
    expect(result).toContain('Salon');
    expect(result).toContain('Chambre');
  });

  test('strips all bullet character variants', () => {
    const bullets = '• ◦ ▪ ▫ ● ○ ■ □ ◆ ◇';
    const result = toSingleParagraphPlainText(bullets);
    // Each bullet becomes a space; no bullet char should remain
    for (const char of ['•', '◦', '▪', '▫', '●', '○', '■', '□', '◆', '◇']) {
      expect(result).not.toContain(char);
    }
  });

  test('collapses \\n into single space', () => {
    const result = toSingleParagraphPlainText('ligne 1\nligne 2\nligne 3');
    expect(result).not.toContain('\n');
    expect(result).toBe('ligne 1 ligne 2 ligne 3');
  });

  test('collapses \\r\\n (Windows line endings)', () => {
    const result = toSingleParagraphPlainText('ligne 1\r\nligne 2');
    expect(result).not.toContain('\r');
    expect(result).not.toContain('\n');
    expect(result).toBe('ligne 1 ligne 2');
  });

  test('collapses multiple consecutive spaces into one', () => {
    const result = toSingleParagraphPlainText('mot1   mot2     mot3');
    expect(result).toBe('mot1 mot2 mot3');
  });

  test('trims leading and trailing whitespace', () => {
    expect(toSingleParagraphPlainText('   bonjour   ')).toBe('bonjour');
  });

  test('handles null-like value gracefully (returns empty string)', () => {
    // The function does String(input ?? ''), so null → ''
    expect(toSingleParagraphPlainText(null as unknown as string)).toBe('');
  });

  test('handles undefined gracefully (returns empty string)', () => {
    expect(toSingleParagraphPlainText(undefined as unknown as string)).toBe('');
  });

  test('handles empty string (returns empty string)', () => {
    expect(toSingleParagraphPlainText('')).toBe('');
  });

  test('real-world: HA markdown response becomes TTS-ready', () => {
    const haMarkdown = [
      '## Météo du jour',
      '',
      '**Température** : 18°C',
      '**Humidité** : 65%',
      '',
      '• Ciel dégagé',
      '• Vent 12 km/h',
      '',
      '> Bonne journée !',
    ].join('\n');

    const result = toSingleParagraphPlainText(haMarkdown);

    expect(result).not.toContain('#');
    expect(result).not.toContain('*');
    expect(result).not.toContain('•');
    expect(result).not.toContain('>');
    expect(result).not.toContain('\n');
    expect(result).toContain('Température');
    expect(result).toContain('18°C');
    expect(result).toContain('Ciel dégagé');
    // No double spaces
    expect(result).not.toMatch(/ {2}/);
  });

  test('multi-target join output (two clean parts) stays clean after plain text', () => {
    // Simulate what the multi-join produces, then it flows through toSingleParagraphPlainText
    const joined = 'Musique lancée. Il fait 18°C, ciel dégagé.';
    expect(toSingleParagraphPlainText(joined)).toBe(joined);
  });
});
