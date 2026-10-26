import { describe, expect, it } from 'vitest';
import {
  applyDictionary,
  applySpokenPunctuation,
  capitalizeSentences,
  cleanTranscript,
  countWords,
  ensureTerminalPunctuation,
  formatDuration,
  removeFillerWords,
  tidyWhitespace,
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

  it('treats spoken sentence breaks as boundaries for scratch that', () => {
    expect(cleanTranscript('today was good period I went to the shop scratch that I went to the gym period it was fun')).toBe(
      'Today was good. I went to the gym. It was fun.',
    );
    expect(cleanTranscript('first paragraph new paragraph second paragraph scratch that the second point')).toBe(
      'First paragraph\n\nThe second point.',
    );
    expect(cleanTranscript('first point new line second point scratch that third point')).toBe('First point\nThird point.');
    expect(cleanTranscript('hello question mark second scratch that third')).toBe('Hello? Third.');
  });

  it('processes every scratch that in a sentence', () => {
    expect(cleanTranscript('I like cats scratch that I like dogs scratch that I like birds')).toBe('I like birds.');
    expect(cleanTranscript('one scratch that two scratch that three')).toBe('Three.');
    expect(cleanTranscript('one scratch that scratch that two')).toBe('Two.');
    expect(cleanTranscript('First. Second scratch that third. Fourth delete that fifth')).toBe('First. Third. Fifth.');
  });

  it('lets a scratch that spoken after a pause remove the previous sentence (Whisper form)', () => {
    expect(cleanTranscript('I like cats. Scratch that. I like dogs.')).toBe('I like dogs.');
    expect(cleanTranscript('First sentence. Second one. Delete that. Third one.')).toBe('First sentence. Third one.');
    expect(cleanTranscript('Hello world.\nScratch that.\nGoodbye.')).toBe('Goodbye.');
    expect(cleanTranscript('Send it to Bob. Actually, scratch that. Send it to Alice.')).toBe('Send it to Alice.');
    expect(cleanTranscript('Scratch that. Hello.')).toBe('Hello.');
    expect(cleanTranscript('I like cats, scratch that, I like dogs.')).toBe('I like dogs.');
  });

  it('leaves command words alone inside hyphenated compounds', () => {
    expect(cleanTranscript('Export it as a comma-separated file.')).toBe('Export it as a comma-separated file.');
    expect(cleanTranscript('the end-of-period report is due')).toBe('The end-of-period report is due.');
    expect(cleanTranscript('comma-delimited')).toBe('Comma-delimited.');
    expect(cleanTranscript('a period-end review')).toBe('A period-end review.');
    expect(cleanTranscript('well-known fact period')).toBe('Well-known fact.');
  });

  it('collapses parenthetical fillers to one comma', () => {
    expect(cleanTranscript('Yes, um, I agree')).toBe('Yes, I agree.');
    expect(cleanTranscript('Um, hello there')).toBe('Hello there.');
    expect(cleanTranscript('hello um.')).toBe('Hello.');
  });

  it('leaves real words that contain filler letters alone', () => {
    expect(cleanTranscript('summer humming drummer')).toBe('Summer humming drummer.');
    expect(cleanTranscript('the gap is about 5 mm wide', { spokenPunctuation: false })).toBe('The gap is about 5 mm wide.');
    expect(cleanTranscript('I went to the ER yesterday', { spokenPunctuation: false })).toBe('I went to the ER yesterday.');
    expect(cleanTranscript('the HM Treasury report')).toBe('The HM Treasury report.');
  });

  it('keeps the line break before a filler', () => {
    expect(cleanTranscript('first point new paragraph um second point')).toBe('First point\n\nSecond point.');
    expect(cleanTranscript('first line new line uh second line')).toBe('First line\nSecond line.');
    expect(cleanTranscript('First point.\n\nUm, second point.', { spokenPunctuation: false })).toBe('First point.\n\nSecond point.');
    expect(cleanTranscript('um\nuh')).toBe('');
  });

  it('does not treat abbreviations as sentence ends', () => {
    expect(cleanTranscript('bring fruit, e.g. apples, to the party', { spokenPunctuation: false })).toBe(
      'Bring fruit, e.g. apples, to the party.',
    );
    expect(cleanTranscript('use the tool, i.e. the hammer', { spokenPunctuation: false })).toBe('Use the tool, i.e. the hammer.');
    expect(cleanTranscript('the U.K. and the U.S. agreed', { spokenPunctuation: false })).toBe('The U.K. and the U.S. agreed.');
    expect(cleanTranscript('see Dr. Smith at 3 p.m. tomorrow', { spokenPunctuation: false })).toBe('See Dr. Smith at 3 p.m. tomorrow.');
    expect(cleanTranscript('cats vs. dogs is an old debate', { spokenPunctuation: false })).toBe('Cats vs. dogs is an old debate.');
    // single-letter words and "no." still end sentences
    expect(cleanTranscript('plan b period then we go')).toBe('Plan b. Then we go.');
    expect(cleanTranscript('no. we will not', { spokenPunctuation: false })).toBe('No. We will not.');
    expect(cleanTranscript('so do i. anyway', { spokenPunctuation: false })).toBe('So do I. Anyway.');
  });

  it('capitalises a sentence that opens with a quote or parenthesis', () => {
    expect(cleanTranscript('he said period open quote hello close quote')).toBe('He said. "Hello"');
    expect(cleanTranscript('intro new paragraph open quote quoted line close quote')).toBe('Intro\n\n"Quoted line"');
    expect(cleanTranscript('first new line open paren aside close paren')).toBe('First\n(Aside)');
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
    expect(cleanTranscript('i’m sure i’ll go and i’d like that')).toBe('I’m sure I’ll go and I’d like that.');
    expect(cleanTranscript('so i think i’d go', { spokenPunctuation: false })).toBe('So I think I’d go.');
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
    expect(cleanTranscript('Um.')).toBe('');
    expect(cleanTranscript('Hmm...', { spokenPunctuation: false })).toBe('');
    expect(cleanTranscript('Uh, um?')).toBe('');
    expect(cleanTranscript('period')).toBe('');
    expect(cleanTranscript('42.')).toBe('42.'); // digits still count as content
  });

  it('replaces a trailing comma with the full stop', () => {
    expect(cleanTranscript('I was going to say,', { spokenPunctuation: false })).toBe('I was going to say.');
    expect(cleanTranscript('send it to bob comma')).toBe('Send it to bob.');
    expect(cleanTranscript('first part, um')).toBe('First part.');
    expect(cleanTranscript('trailing,', { ensureTerminalPunctuation: false })).toBe('Trailing,');
  });

  it('does not glue a dot-led token such as .NET to the previous word', () => {
    expect(cleanTranscript('we use dot net at work', { dictionary: [{ from: 'dot net', to: '.NET' }] })).toBe('We use .NET at work.');
    expect(cleanTranscript('we use .net at work', { dictionary: [{ from: '.net', to: '.NET' }] })).toBe('We use .NET at work.');
    expect(cleanTranscript('edit the .env file')).toBe('Edit the .env file.');
    expect(cleanTranscript('wait ,there')).toBe('Wait, there.');
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
    expect(applySpokenPunctuation('a comma-separated file')).toBe('a comma-separated file');
    expect(applySpokenPunctuation('use a semi-colon here')).toBe('use a; here');
  });

  it('removeFillerWords is case-insensitive and keeps line breaks', () => {
    expect(removeFillerWords('UM hello Uh there')).toBe('hello there');
    expect(removeFillerWords('first point\n\num second point')).toBe('first point\n\nsecond point');
  });

  it('capitalizeSentences handles newlines and quotes', () => {
    expect(capitalizeSentences('one. two\nthree')).toBe('One. Two\nThree');
    expect(capitalizeSentences('"quoted" start')).toBe('"Quoted" start');
    expect(capitalizeSentences('okay. "hello there," she said.')).toBe('Okay. "Hello there," she said.');
    expect(capitalizeSentences('“hello.” then he left.')).toBe('“Hello.” Then he left.');
    expect(capitalizeSentences('the word "foo" is fine')).toBe('The word "foo" is fine');
    expect(capitalizeSentences('one. "two" (three)\n(four)')).toBe('One. "Two" (three)\n(Four)');
    expect(capitalizeSentences('“i’ll go” he said')).toBe('“I’ll go” he said');
  });

  it('tidyWhitespace and ensureTerminalPunctuation edge cases', () => {
    expect(tidyWhitespace('we use .NET and .com domains')).toBe('we use .NET and .com domains');
    expect(ensureTerminalPunctuation('hi,')).toBe('hi.');
    expect(ensureTerminalPunctuation('he said “hi.”')).toBe('he said “hi.”');
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
