/**
 * Incremental decoder for the legacy, text-framed thinking protocol.
 *
 * The wire grammar is deliberately narrow:
 *
 *   TEXT? LINE_START HSPACE* "<thinking>" ("\n" | "\r\n")?
 *   THINKING_BODY "</thinking>" (WS* at a boundary | "\n\n" | "\r\n\r\n") TEXT
 *
 * Two rules do all the work, and neither is a heuristic about the characters
 * around a tag:
 *
 *  1. **An opening tag only counts at the start of a line** (optionally after
 *     horizontal whitespace). Models write the tag on its own line; an inline
 *     `<thinking>` inside a sentence is the model *talking about* the tag.
 *     Text before it stays visible text.
 *  2. **At most one block, and only before it closes.** Once the block has
 *     closed — or a boundary has settled the phase — every later tag-shaped
 *     string is ordinary text.
 *
 * ★ Rule 1 must not be tightened to "response prologue only". Doing so makes
 * any preamble reclassify the whole chain of thought as visible text, and the
 * leaked-tool-call rescue detector then materializes an `<invoke>` the model
 * merely *drafted* while thinking into a real tool_use — the phantom-execution
 * red line in `tool-call-text.ts`. An unclosed block staying thinking at EOF
 * guards the same property from the other side.
 *
 * ★ Rule 1 must not be loosened to "anywhere" either: a mid-sentence mention
 * would open a block that never finds a valid close, swallowing the entire
 * response into the thinking channel.
 *
 * `feed()` keeps only an undecided leading run of whitespace, or the longest
 * suffix that can still become a tag or a closing delimiter, so its retained
 * buffer is bounded independently of response size. Payload item boundaries
 * may follow input chunk boundaries; concatenating adjacent `thinking`/`text`
 * items is chunk-invariant.
 */

const OPEN_TAG = '<thinking>';
const CLOSE_TAG = '</thinking>';
const LF_SEPARATOR = '\n\n';
const CRLF_SEPARATOR = '\r\n\r\n';

/**
 * A finite prologue is part of the protocol, rather than an unbounded search
 * through response text. The normal upstream form uses zero or one newline;
 * 64 code units leaves generous tolerance while keeping undecided input
 * bounded even for a whitespace-only stream.
 */
export const LEGACY_THINKING_MAX_LEADING_WHITESPACE = 64;

/**
 * How much whitespace after a close tag can stay undecided. A close tag whose
 * separator has not resolved yet is held in the buffer; capping the run keeps
 * that hold bounded even if a model emits a long whitespace tail.
 */
const MAX_UNDECIDED_SEPARATOR_WHITESPACE = 16;

/**
 * Maximum code units retained after a non-terminal `feed()` call. The prologue
 * is the widest hold; an undecided close tag plus its whitespace tail
 * (`CLOSE_TAG.length + MAX_UNDECIDED_SEPARATOR_WHITESPACE`) stays below it.
 */
export const LEGACY_THINKING_MAX_BUFFERED_CODE_UNITS =
  LEGACY_THINKING_MAX_LEADING_WHITESPACE + OPEN_TAG.length - 1;

/**
 * Why a thinking block ended. `delimiter` means the model actually closed it;
 * every other value is the decoder closing it on the model's behalf, and names
 * the out-of-band event that forced the issue. Keep these distinct — collapsing
 * the implicit reasons would merge unrelated upstream behaviours into one
 * bucket the moment anyone counts them.
 */
export type LegacyThinkingEndReason =
  | 'delimiter'
  | 'tool_boundary'
  | 'native_takeover'
  | 'eof_unclosed';

/** Out-of-band events that close an open thinking block without a delimiter. */
export type LegacyThinkingBoundaryReason = 'tool_boundary' | 'native_takeover';

export type LegacyThinkingDecoderItem =
  | { type: 'thinking_start' }
  | { type: 'thinking'; text: string }
  | { type: 'thinking_end'; reason: LegacyThinkingEndReason }
  | { type: 'text'; text: string };

type DecoderState = 'prologue' | 'after_open_eol' | 'thinking' | 'text' | 'finished';
type SeparatorDecision =
  | { type: 'match'; length: number }
  | { type: 'partial' }
  | { type: 'invalid' };

export class LegacyThinkingDecoder {
  private state: DecoderState = 'prologue';
  private buffer = '';
  /** Whether the not-yet-emitted part of the current line is all whitespace. */
  private lineBlank = true;
  /** Whether any visible text has already been released before the tag search. */
  private emittedLeadingText = false;

  /** Exposed for invariant tests and operational diagnostics. */
  get bufferedCodeUnits(): number {
    return this.buffer.length;
  }

  /**
   * True once no later input can change any classification — every remaining
   * byte is plain text, and `boundary()`/`finish()` have nothing left to emit.
   *
   * Reached when the single thinking block closes, or when a boundary settles
   * the phase. Consumers drop their reference here so the per-frame hot path
   * stops routing through a decoder that has become an identity function.
   */
  get isPassthrough(): boolean {
    return this.state === 'text' || this.state === 'finished';
  }

  /**
   * True while a thinking block is open — the opening tag was decoded and no
   * close has been seen yet.
   *
   * Callers use this to tell a *tentative* classification from a committed
   * one. Retiring the decoder mid-block discards the framing, so everything
   * still to come — the rest of the private reasoning and the literal
   * `</thinking>` — lands in the visible text channel.
   */
  get hasOpenThinking(): boolean {
    return this.state === 'after_open_eol' || this.state === 'thinking';
  }

  feed(chunk: string): LegacyThinkingDecoderItem[] {
    if (!chunk || this.state === 'finished') return [];

    this.buffer += chunk;
    const items: LegacyThinkingDecoderItem[] = [];
    this.drain(items);
    return items;
  }

  /**
   * Close the current phase because an out-of-band event happened — a
   * structured tool-use frame, or native reasoning taking over. The decoder
   * stays usable: later text is decoded as ordinary text.
   *
   * A complete close tag followed by a valid, unfinished separator prefix is
   * accepted as an explicit close. Without one, an open thinking block is
   * closed implicitly so no other block can be interleaved inside it.
   */
  boundary(reason: LegacyThinkingBoundaryReason): LegacyThinkingDecoderItem[] {
    if (this.state === 'finished' || this.state === 'text') return [];

    const items: LegacyThinkingDecoderItem[] = [];
    if (this.state === 'prologue') {
      this.enterText(items);
      return items;
    }

    this.settleOpenThinking(items, reason);
    this.state = 'text';
    return items;
  }

  /** Finish decoding. Safe to call more than once. */
  finish(): LegacyThinkingDecoderItem[] {
    if (this.state === 'finished') return [];

    const items: LegacyThinkingDecoderItem[] = [];
    if (this.state === 'prologue') {
      this.emit(items, 'text', this.buffer);
    } else if (this.state === 'after_open_eol' || this.state === 'thinking') {
      this.settleOpenThinking(items, 'eof_unclosed');
    }

    this.buffer = '';
    this.state = 'finished';
    return items;
  }

  /**
   * Close an open thinking block at a boundary, shared by every implicit
   * close. Whether the trailing buffer becomes thinking content or is consumed
   * as an explicit close delimiter must be decided in exactly one place.
   */
  private settleOpenThinking(
    items: LegacyThinkingDecoderItem[],
    fallbackReason: LegacyThinkingEndReason,
  ): void {
    this.resolveOptionalOpenEolAtBoundary();
    const hasExplicitClose = this.consumeBoundaryCloseCandidate();
    if (!hasExplicitClose) {
      this.emit(items, 'thinking', this.buffer);
      this.buffer = '';
    }
    items.push({
      type: 'thinking_end',
      reason: hasExplicitClose ? 'delimiter' : fallbackReason,
    });
  }

  private drain(items: LegacyThinkingDecoderItem[]): void {
    // A single chunk can cross every state, so keep advancing until the
    // current state needs more input or has drained its buffer.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      switch (this.state) {
        case 'prologue':
          if (!this.drainPrologue(items)) return;
          break;
        case 'after_open_eol':
          if (!this.drainOptionalOpenEol()) return;
          break;
        case 'thinking':
          if (!this.drainThinking(items)) return;
          break;
        case 'text':
          this.emit(items, 'text', this.buffer);
          this.buffer = '';
          return;
        case 'finished':
          this.buffer = '';
          return;
      }
    }
  }

  /**
   * Look for a line-start opening tag, releasing everything that provably
   * precedes one as visible text.
   *
   * Unlike a prologue-only rule this keeps searching past ordinary text, so a
   * model that writes a sentence before opening its thinking block still gets
   * that block decoded (and its drafted tool calls kept out of rescue). Text is
   * released as it is proven ordinary, so the buffer never grows with the
   * response — only an undecided leading whitespace run or a partial tag is
   * held.
   *
   * Return true when a block was opened and draining can continue.
   */
  private drainPrologue(items: LegacyThinkingDecoderItem[]): boolean {
    for (let searchFrom = 0; ; ) {
      const position = this.buffer.indexOf(OPEN_TAG, searchFrom);
      if (position === -1) break;

      if (this.isTagAtLineStart(position)) {
        const before = this.buffer.slice(0, position);
        // Whitespace that only indents the tag is framing, not content —
        // emitting it would open a text block ahead of the thinking block.
        if (before && (this.emittedLeadingText || !isAllAsciiWhitespace(before))) {
          this.releaseLeadingText(items, before);
        }
        this.buffer = this.buffer.slice(position + OPEN_TAG.length);
        this.state = 'after_open_eol';
        items.push({ type: 'thinking_start' });
        return true;
      }
      searchFrom = position + 1;
    }

    // No opening tag yet. Release everything that cannot still become one.
    const retainedLength = longestSuffixPrefixLength(this.buffer, OPEN_TAG);
    let emitLength = this.buffer.length - retainedLength;
    if (emitLength > 0 && isHighSurrogate(this.buffer.charCodeAt(emitLength - 1))) emitLength--;
    if (emitLength <= 0) return false;

    // A purely blank start is still undecided: `\n<thinking>` is the common
    // shape, and releasing that newline would put a text block first. Bounded,
    // so a whitespace-only stream cannot grow the buffer without limit.
    if (
      !this.emittedLeadingText &&
      isAllAsciiWhitespace(this.buffer.slice(0, emitLength)) &&
      this.buffer.length <= LEGACY_THINKING_MAX_LEADING_WHITESPACE
    ) {
      return false;
    }

    this.releaseLeadingText(items, this.buffer.slice(0, emitLength));
    this.buffer = this.buffer.slice(emitLength);
    return false;
  }

  /**
   * Whether an opening tag at `position` begins a line — nothing but
   * horizontal whitespace stands between it and the previous line break.
   */
  private isTagAtLineStart(position: number): boolean {
    const before = this.buffer.slice(0, position);
    const lastNewline = before.lastIndexOf('\n');
    if (lastNewline !== -1) return isAllAsciiWhitespace(before.slice(lastNewline + 1));
    // No break in the buffer: the line continues from already-released text.
    return this.lineBlank && isAllAsciiWhitespace(before);
  }

  /** Emit pre-tag text and carry the line-start bookkeeping across releases. */
  private releaseLeadingText(items: LegacyThinkingDecoderItem[], text: string): void {
    this.emit(items, 'text', text);
    this.emittedLeadingText = true;
    const lastNewline = text.lastIndexOf('\n');
    this.lineBlank =
      lastNewline === -1
        ? this.lineBlank && isAllAsciiWhitespace(text)
        : isAllAsciiWhitespace(text.slice(lastNewline + 1));
  }

  /** Return true when the optional line ending is decided. */
  private drainOptionalOpenEol(): boolean {
    if (!this.buffer) return false;

    if (this.buffer.startsWith('\n')) {
      this.buffer = this.buffer.slice(1);
    } else if (this.buffer.startsWith('\r')) {
      if (this.buffer.length === 1) return false;
      if (this.buffer.startsWith('\r\n')) this.buffer = this.buffer.slice(2);
    }

    this.state = 'thinking';
    return true;
  }

  /** Return true when a delimiter moved the decoder into text state. */
  private drainThinking(items: LegacyThinkingDecoderItem[]): boolean {
    // Invalid tag-shaped strings are thinking content. Continue until either a
    // valid delimiter is found or only an undecidable suffix remains.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const closePosition = this.buffer.indexOf(CLOSE_TAG);
      if (closePosition !== -1) {
        this.emit(items, 'thinking', this.buffer.slice(0, closePosition));
        this.buffer = this.buffer.slice(closePosition);

        const separator = decideSeparator(this.buffer.slice(CLOSE_TAG.length));
        if (separator.type === 'match') {
          this.buffer = this.buffer.slice(CLOSE_TAG.length + separator.length);
          items.push({ type: 'thinking_end', reason: 'delimiter' });
          this.state = 'text';
          return true;
        }
        if (separator.type === 'partial') return false;

        // CLOSE_TAG has no self-overlap, so after an invalid suffix it is safe
        // to emit the whole tag before scanning the remaining input again.
        this.emit(items, 'thinking', CLOSE_TAG);
        this.buffer = this.buffer.slice(CLOSE_TAG.length);
        continue;
      }

      const retainedLength = longestSuffixPrefixLength(this.buffer, CLOSE_TAG);
      let emittedLength = this.buffer.length - retainedLength;

      // A caller can split a JS string between UTF-16 surrogate code units.
      // Retain a terminal high surrogate so one emitted delta never tears a
      // pair that arrived across two feed calls.
      if (emittedLength > 0 && isHighSurrogate(this.buffer.charCodeAt(emittedLength - 1))) {
        emittedLength--;
      }

      this.emit(items, 'thinking', this.buffer.slice(0, emittedLength));
      this.buffer = this.buffer.slice(emittedLength);
      return false;
    }
  }

  private enterText(items: LegacyThinkingDecoderItem[]): void {
    this.state = 'text';
    this.emit(items, 'text', this.buffer);
    this.buffer = '';
  }

  private resolveOptionalOpenEolAtBoundary(): void {
    if (this.state !== 'after_open_eol') return;
    // A lone CR could only have become the optional CRLF with more input. At a
    // boundary it is ordinary thinking content; an empty buffer is empty body.
    this.state = 'thinking';
  }

  /**
   * At a boundary the trailing separator can legitimately be missing: the
   * stream simply ended, or a tool frame arrived, before the model wrote the
   * blank line. Accept a close tag followed by nothing but whitespace.
   *
   * Requiring a *prefix of* the separator here would be too strict — trailing
   * spaces are whitespace but not a `\n\n` prefix, so `</thinking>  ` at EOF
   * would fall through and the literal tag would end up inside the thinking
   * text, then round-trip into history via converter.ts's reconstruction as a
   * duplicated marker. Only whitespace is allowed, so real content after an
   * unterminated close tag still counts as thinking (the phantom-execution
   * rule in the file header).
   */
  private consumeBoundaryCloseCandidate(): boolean {
    if (!this.buffer.startsWith(CLOSE_TAG)) return false;

    const suffix = this.buffer.slice(CLOSE_TAG.length);
    if (!isAllAsciiWhitespace(suffix)) return false;

    this.buffer = '';
    return true;
  }

  private emit(items: LegacyThinkingDecoderItem[], type: 'thinking' | 'text', text: string): void {
    if (!text) return;

    const previous = items.at(-1);
    if (previous?.type === type) {
      previous.text += text;
      return;
    }
    items.push({ type, text });
  }
}

function isAsciiWhitespace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d);
}

function isAllAsciiWhitespace(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (!isAsciiWhitespace(value.charCodeAt(index))) return false;
  }
  return true;
}

function decideSeparator(afterTag: string): SeparatorDecision {
  if (afterTag.startsWith(LF_SEPARATOR)) {
    return { type: 'match', length: LF_SEPARATOR.length };
  }
  if (afterTag.startsWith(CRLF_SEPARATOR)) {
    return { type: 'match', length: CRLF_SEPARATOR.length };
  }
  if (isValidIncompleteSeparator(afterTag)) return { type: 'partial' };
  return { type: 'invalid' };
}

/**
 * Whether `value` can still become a valid separator with more input, or be
 * accepted as-is at a boundary.
 *
 * Any run of ASCII whitespace qualifies, not just a prefix of `\n\n`. A model
 * that closes with `</thinking>` plus trailing spaces and then stops has still
 * closed the block — treating those spaces as "not a separator" would push the
 * literal close tag into the thinking text, which then round-trips into
 * history through converter.ts's reconstruction as a duplicated marker.
 * Anything non-whitespace decides immediately (the tag was thinking content),
 * so the buffer stays bounded by `MAX_UNDECIDED_SEPARATOR_WHITESPACE`.
 */
function isValidIncompleteSeparator(value: string): boolean {
  return value.length <= MAX_UNDECIDED_SEPARATOR_WHITESPACE && isAllAsciiWhitespace(value);
}

function longestSuffixPrefixLength(value: string, target: string): number {
  const maxLength = Math.min(value.length, target.length - 1);
  for (let length = maxLength; length > 0; length--) {
    if (value.endsWith(target.slice(0, length))) return length;
  }
  return 0;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
