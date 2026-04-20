const CHAR_MAP = new Map<string, number>([
  ['0', 0x30], ['1', 0x31], ['2', 0x32], ['3', 0x33], ['4', 0x34],
  ['5', 0x35], ['6', 0x36], ['7', 0x37], ['8', 0x38], ['9', 0x39],
  ['A', 0x41], ['B', 0x42], ['C', 0x43], ['D', 0x44], ['E', 0x45],
  ['F', 0x46], ['G', 0x47], ['H', 0x48], ['I', 0x49], ['J', 0x4a],
  ['K', 0x4b], ['L', 0x4c], ['M', 0x4d], ['N', 0x4e], ['O', 0x4f],
  ['P', 0x50], ['Q', 0x51], ['R', 0x52], ['S', 0x53], ['T', 0x54],
  ['U', 0x55], ['V', 0x56], ['W', 0x57], ['X', 0x58], ['Y', 0x59],
  ['Z', 0x5a],
  ['θ', 0x5b],
  ['→', 0x04],
  ['"', 0x2a],
  [',', 0x2b],
  ['(', 0x10],
  [')', 0x11],
  ['+', 0x70],
  ['-', 0x71],
  ['*', 0x82],
  ['/', 0x83],
  ['^', 0xf0],
  ['.', 0x3a],
  ['=', 0x6b],
  ['<', 0x6c],
  ['≤', 0x6d],
  ['>', 0x6e],
  ['≥', 0x6f],
  ['≠', 0x6a],
  [' ', 0x29]
]);

const COMMAND_TOKENS: Array<[string, number[]]> = [
  ['DispGraph', [0xdf]],
  ['ClrHome', [0xe1]],
  ['Output(', [0xe0]],
  ['getKey', [0xad]],
  ['IS>(', [0xda]],
  ['DS<(', [0xdb]],
  ['SortA(', [0xe3]],
  ['SortD(', [0xe4]],
  ['Menu(', [0xe6]],
  ['Disp ', [0xde]],
  ['Disp', [0xde]],
  ['Input ', [0xdc]],
  ['Input', [0xdc]],
  ['Prompt ', [0xdd]],
  ['Prompt', [0xdd]],
  ['Pause ', [0xd8]],
  ['Pause', [0xd8]],
  ['Repeat ', [0xd2]],
  ['Repeat', [0xd2]],
  ['Return', [0xd5]],
  ['While ', [0xd1]],
  ['While', [0xd1]],
  ['Stop', [0xd9]],
  ['Goto ', [0xd7]],
  ['Goto', [0xd7]],
  ['Lbl ', [0xd6]],
  ['Lbl', [0xd6]],
  ['For(', [0xd3]],
  ['Then', [0xcf]],
  ['Else', [0xd0]],
  ['End', [0xd4]],
  ['If ', [0xce]],
  ['If', [0xce]],
  ['Ans', [0x72]],
  ['prgm', [0xbb, 0x72]],
  ['sqrt(', [0xbb, 0x64]],
  ['abs(', [0xb1]],
  ['int(', [0xb6]],
  ['round(', [0xb9]],
  ['not(', [0xb0]],
  ['and', [0x7f]],
  ['or', [0x80]],
  ['xor', [0x81]],
  ['->', [0x04]],
  ['→', [0x04]]
];

function parseMenuArgs(content: string) {
  const args: string[] = [];
  let current = '';
  let inQuote = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char === '"') {
      inQuote = !inQuote;
      current += char;
    } else if (char === ',' && !inQuote) {
      args.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    args.push(current.trim());
  }
  return args;
}

export function validateTi84Labels(code: string) {
  const errors: string[] = [];
  const declared = new Set<string>();
  const lblRe = /\bLbl\s+([A-Z0-9]{1,2})\b/g;
  let match: RegExpExecArray | null;
  while ((match = lblRe.exec(code)) !== null) {
    declared.add(match[1]);
  }

  const referenced = new Map<string, string>();
  const gotoRe = /\bGoto\s+([A-Z0-9]{1,2})\b/g;
  while ((match = gotoRe.exec(code)) !== null) {
    if (!referenced.has(match[1])) {
      referenced.set(match[1], `Goto ${match[1]}`);
    }
  }

  const menuRe = /Menu\(/g;
  while ((match = menuRe.exec(code)) !== null) {
    const start = match.index + match[0].length;
    let depth = 1;
    let position = start;
    while (position < code.length && depth > 0) {
      if (code[position] === '(') {
        depth += 1;
      } else if (code[position] === ')') {
        depth -= 1;
      }
      position += 1;
    }
    const args = parseMenuArgs(code.slice(start, position - 1));
    for (let index = 2; index < args.length; index += 2) {
      const label = args[index].replace(/"/g, '').trim();
      if (/^[A-Z0-9]{1,2}$/.test(label) && !referenced.has(label)) {
        referenced.set(label, `Menu option -> ${label}`);
      }
    }
  }

  for (const [label, context] of referenced) {
    if (!declared.has(label)) {
      errors.push(`Missing Lbl ${label} (referenced by: ${context})`);
    }
  }

  return errors;
}

export function deriveTi84ProgramName(subject: string) {
  const upper = subject.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const firstLetter = upper.search(/[A-Z]/);
  const normalized = firstLetter >= 0 ? upper.slice(firstLetter) : 'PROG';
  return normalized.slice(0, 8) || 'PROG';
}

function tokenize(code: string) {
  const tokens: number[] = [];
  const lines = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (lineIndex > 0) {
      tokens.push(0x3f);
    }

    const line = lines[lineIndex];
    let index = 0;
    while (index < line.length) {
      let matched = false;
      for (const [command, bytes] of COMMAND_TOKENS) {
        if (line.startsWith(command, index)) {
          tokens.push(...bytes);
          index += command.length;
          matched = true;
          break;
        }
      }
      if (matched) {
        continue;
      }

      const char = line[index];
      if (CHAR_MAP.has(char)) {
        tokens.push(CHAR_MAP.get(char)!);
        index += 1;
        continue;
      }

      const upper = char.toUpperCase();
      if (upper !== char && CHAR_MAP.has(upper)) {
        tokens.push(CHAR_MAP.get(upper)!);
        index += 1;
        continue;
      }

      index += 1;
    }
  }

  return new Uint8Array(tokens);
}

export function encodeTi84Program(programName: string, tiBasicCode: string) {
  const tokenBody = tokenize(tiBasicCode);
  const tokenLen = tokenBody.length;
  const varDataLen = tokenLen + 2;

  const nameBytes = new Uint8Array(8);
  const cleanName = programName.toUpperCase().replace(/[^A-Z0-9θ]/g, '').slice(0, 8);
  for (let index = 0; index < cleanName.length; index += 1) {
    nameBytes[index] = cleanName.charCodeAt(index);
  }

  const varEntryLen = 19 + tokenLen;
  const varEntry = new Uint8Array(varEntryLen);
  varEntry[0] = 0x0b;
  varEntry[1] = 0x00;
  varEntry[2] = varDataLen & 0xff;
  varEntry[3] = (varDataLen >> 8) & 0xff;
  varEntry[4] = 0x05;
  for (let index = 0; index < 8; index += 1) {
    varEntry[5 + index] = nameBytes[index];
  }
  varEntry[13] = 0x00;
  varEntry[14] = 0x00;
  varEntry[15] = varDataLen & 0xff;
  varEntry[16] = (varDataLen >> 8) & 0xff;
  varEntry[17] = tokenLen & 0xff;
  varEntry[18] = (tokenLen >> 8) & 0xff;
  for (let index = 0; index < tokenLen; index += 1) {
    varEntry[19 + index] = tokenBody[index];
  }

  let checksum = 0;
  for (const byte of varEntry) {
    checksum += byte;
  }
  checksum &= 0xffff;

  const signature = [0x2a, 0x2a, 0x54, 0x49, 0x38, 0x33, 0x46, 0x2a, 0x1a, 0x0a, 0x00];
  const comment = 'Created by Walt TI-84';
  const commentBytes = new Uint8Array(42);
  for (let index = 0; index < Math.min(comment.length, 42); index += 1) {
    commentBytes[index] = comment.charCodeAt(index);
  }

  const metaBodyLen = varEntryLen;
  const totalLen = 11 + 42 + 2 + varEntryLen + 2;
  const file = new Uint8Array(totalLen);
  let offset = 0;

  signature.forEach((byte) => {
    file[offset] = byte;
    offset += 1;
  });
  commentBytes.forEach((byte) => {
    file[offset] = byte;
    offset += 1;
  });
  file[offset] = metaBodyLen & 0xff;
  offset += 1;
  file[offset] = (metaBodyLen >> 8) & 0xff;
  offset += 1;
  varEntry.forEach((byte) => {
    file[offset] = byte;
    offset += 1;
  });
  file[offset] = checksum & 0xff;
  offset += 1;
  file[offset] = (checksum >> 8) & 0xff;

  return file;
}
