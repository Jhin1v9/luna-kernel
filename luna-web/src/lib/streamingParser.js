/**
 * StreamingParser — state-machine para extrair texto limpo de chunks SSE,
 * descartando blocos JSON que representam chamadas de ferramentas.
 */
export class StreamingParser {
  constructor() {
    this.state = 'TEXT';
    this.output = '';
    this.jsonBuffer = '';
    this.braceDepth = 0;
    this.inString = false;
    this.stringEscape = false;
  }

  reset() {
    this.state = 'TEXT';
    this.output = '';
    this.jsonBuffer = '';
    this.braceDepth = 0;
    this.inString = false;
    this.stringEscape = false;
  }

  feed(chunk) {
    for (const char of chunk) {
      this._consume(char);
    }
    return this.output;
  }

  _consume(char) {
    switch (this.state) {
      case 'TEXT': {
        if (char === '{') {
          this.state = 'JSON_CANDIDATE';
          this.jsonBuffer = '{';
          this.braceDepth = 1;
          this.inString = false;
          this.stringEscape = false;
        } else {
          this.output += char;
        }
        break;
      }
      case 'JSON_CANDIDATE': {
        this.jsonBuffer += char;
        if (this.stringEscape) {
          this.stringEscape = false;
        } else if (char === '\\') {
          this.stringEscape = true;
        } else if (this.inString) {
          if (char === '"') this.inString = false;
        } else {
          if (char === '"') this.inString = true;
          else if (char === '{') this.braceDepth++;
          else if (char === '}') {
            this.braceDepth--;
            if (this.braceDepth === 0) {
              if (!this._isToolJson(this.jsonBuffer)) {
                this.output += this.jsonBuffer;
              }
              this.state = 'TEXT';
              this.jsonBuffer = '';
            }
          }
        }
        break;
      }
    }
  }

  flush() {
    if (this.state === 'JSON_CANDIDATE') {
      if (!this._isToolJson(this.jsonBuffer)) {
        this.output += this.jsonBuffer;
      }
      this.state = 'TEXT';
      this.jsonBuffer = '';
    }
    const result = this.output;
    this.output = '';
    return result;
  }

  _isToolJson(text) {
    return /"tool"\s*:/.test(text) || /"params"\s*:/.test(text);
  }
}
