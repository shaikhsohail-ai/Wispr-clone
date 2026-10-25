import { describe, expect, it } from 'vitest';
import {
  applyDictionary,
  applySpokenPunctuation,
  capitalizeSentences,
  cleanTranscript,
  countWords,
  formatDuration,
  removeFillerWords,
  timeSavedMs,
  wordsPerMinute,
} from './text.js';

describe('cleanTranscript', () => {
  it('removes fillers, capitalises and adds a full stop', () => {
    expect(cleanTranscript('um so i think we should uh ship it')).toBe('So I think we should ship it.');
  });

  it('expands spoken punctuation and line breaks', () => {
    expect(cleanTranscript('hello comma world period new paragraph next line')).toBe('Hello, world.\n\nNext line.');
    expect(cleanTranscript('meet at five question mark')).toBe('Meet at five?');
    expect(cleanTranscript('wow exclamation point')).toBe('Wow!');
    expect(cleanTranscript('first new line second')).toBe('First\nSecond.');
  });

  it('absorbs punctuation an engine adds after the spoken command', () => {
    expect(cleanTranscript('Hello period. Next sentence comma, okay.')).toBe('Hello. Next sentence, okay.');
  });

  it('handles scratch that by dropping the current sentence', () => {
    expect(cleanTranscript('I like cats scratch that I like dogs')).toBe('I like dogs.');
    expect(cleanTranscript('First sentence. Second one delete that third one')).toBe('First sentence. Third one.');
  });

  it('collapses parenthetical fillers to one comma', () => {
    expect(cleanTranscript('Yes, um, I agree')).toBe('Yes, I agree.');
    expect(cleanTranscript('Um, hello there')).toBe('Hello there.');
    expect(cleanTranscript('hello um.')).toBe('Hello.');
  });

  it('leaves real words that contain filler letters alone', () => {
    expect(cleanTranscript('summer humming drummer')).toBe('Summer humming drummer.');
  });

  it('applies the dictionary as whole words, case-insensitively', () => {
    const dictionary = [
      { from: 'john smith', to: 'Jon Smyth' },
      { from: 'c plus plus', to: 'C++' },
    ];
    expect(cleanTranscript('send it to John Smith about c plus plus', { dictionary })).toBe('Send it to Jon Smyth about C++.');
    expect(applyDictionary('smithy', [{ from: 'smith', to: 'X' }])).toBe('smithy');
  });

  it('capitalises the pronoun I and contractions', () => {
    expect(cleanTranscript("i'm sure i can. i will")).toBe("I'm sure I can. I will.");
  });

  it('respects the switches', () => {
    expect(cleanTranscript('hello', { ensureTerminalPunctuation: false })).toBe('Hello');
    expect(cleanTranscript('hello', { capitalize: false })).toBe('hello.');
    expect(cleanTranscript('the trial period', { spokenPunctuation: false })).toBe('The trial period.');
    expect(cleanTranscript('um hello', { removeFillers: false })).toBe('Um hello.');
    expect(cleanTranscript('like totally', { fillerWords: ['like'] })).toBe('Totally.');
  });

  it('returns an empty string for empty or filler-only input', () => {
    expect(cleanTranscript('')).toBe('');
    expect(cleanTranscript('   ')).toBe('');
    expect(cleanTranscript('um uh')).toBe('');
  });

  it('keeps existing punctuation and quotes intact', () => {
    expect(cleanTranscript('Is it done? Yes! "Great," she said.')).toBe('Is it done? Yes! "Great," she said.');
    expect(cleanTranscript('he said open quote hi close quote')).toBe('He said "hi"');
  });

  it('does not add a period after an ellipsis or colon', () => {
    expect(cleanTranscript('wait for it...')).toBe('Wait for it...');
    expect(cleanTranscript('to do colon')).toBe('To do:');
  });

  it('normalises whitespace and stray punctuation', () => {
    expect(cleanTranscript('hello   world ,  how are you ?')).toBe('Hello world, how are you?');
    expect(cleanTranscript('one\r\ntwo')).toBe('One\nTwo.');
  });
});

describe('helpers', () => {
  it('applySpokenPunctuation only touches commands', () => {
    expect(applySpokenPunctuation('a comma b')).toBe('a, b');
    expect(applySpokenPunctuation('the commander')).toBe('the commander');
  });

  it('removeFillerWords is case-insensitive', () => {
    expect(removeFillerWords('UM hello Uh there')).toBe('hello there');
  });

  it('capitalizeSentences handles newlines and quotes', () => {
    expect(capitalizeSentences('one. two\nthree')).toBe('One. Two\nThree');
    expect(capitalizeSentences('"quoted" start')).toBe('"Quoted" start');
  });

  it('countWords ignores punctuation-only tokens', () => {
    expect(countWords('hello world')).toBe(2);
    expect(countWords('')).toBe(0);
    expect(countWords('— ... !')).toBe(0);
    expect(countWords("it's 2 o'clock")).toBe(3);
  });

  it('wordsPerMinute and timeSavedMs', () => {
    expect(wordsPerMinute(100, 60_000)).toBe(100);
    expect(wordsPerMinute(0, 60_000)).toBe(0);
    expect(wordsPerMinute(10, 0)).toBe(0);
    expect(timeSavedMs(40, 15_000)).toBe(45_000);
    expect(timeSavedMs(1, 60_000)).toBe(0);
    expect(timeSavedMs(0, 0)).toBe(0);
  });

  it('formatDuration', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(3_700_000)).toBe('1h 1m');
  });
});
