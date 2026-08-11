const fs = require('fs');
const path = require('path');

const WORDS_PATH = path.join(__dirname, 'chatgame-words.json');
const TRIVIA_PATH = path.join(__dirname, 'chatgame-trivia.json');
const GAMES_PATH = path.join(__dirname, 'chatgames.txt');
const SEPARATOR = '\n---\n';

const normalizeTriviaQuestion = (question) => question.trim().toLowerCase();

const loadTrivia = () => {
    try {
        return new Map(Object.entries(JSON.parse(fs.readFileSync(TRIVIA_PATH, 'utf8'))));
    } catch {
        return new Map();
    }
};

const trivia = loadTrivia();

const loadWords = () => {
    try {
        return new Set(JSON.parse(fs.readFileSync(WORDS_PATH, 'utf8')));
    } catch {
        return new Set();
    }
};

const words = loadWords();

const saveWords = () => {
    fs.writeFileSync(WORDS_PATH, JSON.stringify([...words].sort(), null, 2) + '\n');
};

// chatgames.txt entries that already have a manually- or previously-solved
// "Answer: X" line under the question are treated as known exact matches,
// in addition to the algorithmic solvers below
const loadKnownAnswers = () => {
    const map = new Map();
    let raw;
    try {
        raw = fs.readFileSync(GAMES_PATH, 'utf8');
    } catch {
        return map;
    }
    for (const entry of raw.split(SEPARATOR)) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const lines = trimmed.split('\n');
        const answerMatch = lines[lines.length - 1].match(/^Answer:\s*(.+)$/);
        if (!answerMatch) continue;
        const question = lines.slice(0, -1).join('\n').trim();
        map.set(question, answerMatch[1].trim());
    }
    return map;
};

const knownAnswers = loadKnownAnswers();

// win/result announcements reveal the real word behind a fill-in/unscramble
// puzzle - learn it so future puzzles using the same word can be solved
const ANNOUNCEMENT_ANSWER_PATTERN = /`([^`]+)`\s*\(\d/;

const learnFromAnnouncement = (block) => {
    const match = block.match(ANNOUNCEMENT_ANSWER_PATTERN);
    if (!match) return;
    const answer = match[1].trim();
    if (!/^[A-Za-z]+$/.test(answer)) return; // only word-type answers are useful to learn
    const key = answer.toLowerCase();
    for (const existing of words) {
        if (existing.toLowerCase() === key) return;
    }
    words.add(answer);
    saveWords();
};

const extractPrompt = (block) => {
    // finds the "You have N seconds to <verb>: `value`" prompt, ignoring any
    // unrelated noise lines swept into the block by the buffering window.
    // The backticked value sometimes sits on its own line below the verb
    // line (e.g. trivia questions), so allow any whitespace between them.
    const match = block.match(/seconds to ([a-z ]+):\s*`([^`]+)`/i);
    if (!match) return null;
    return { verb: match[1].trim().toLowerCase(), value: match[2] };
};

// safe arithmetic evaluator: numbers, + - * / and parentheses only (no eval)
const evaluateArithmetic = (expr) => {
    if (!/^[\d\s+\-*/().]+$/.test(expr)) return null;
    let i = 0;
    const peek = () => expr[i];
    const skipSpaces = () => { while (peek() === ' ') i++; };
    const parseNumber = () => {
        const start = i;
        if (peek() === '-') i++;
        while (i < expr.length && /[\d.]/.test(expr[i])) i++;
        if (i === start) return NaN;
        return parseFloat(expr.slice(start, i));
    };
    const parseFactor = () => {
        skipSpaces();
        if (peek() === '(') {
            i++;
            const value = parseExpr();
            skipSpaces();
            if (peek() === ')') i++;
            return value;
        }
        return parseNumber();
    };
    const parseTerm = () => {
        let value = parseFactor();
        while (true) {
            skipSpaces();
            if (peek() === '*' || peek() === '/') {
                const op = expr[i]; i++;
                const rhs = parseFactor();
                value = op === '*' ? value * rhs : value / rhs;
            } else break;
        }
        return value;
    };
    const parseExpr = () => {
        let value = parseTerm();
        while (true) {
            skipSpaces();
            if (peek() === '+' || peek() === '-') {
                const op = expr[i]; i++;
                const rhs = parseTerm();
                value = op === '+' ? value + rhs : value - rhs;
            } else break;
        }
        return value;
    };
    const result = parseExpr();
    return Number.isNaN(result) ? null : Math.round(result * 1e6) / 1e6;
};

// "solve for: `✗`" style puzzles: N-1 equations where every term is the same
// repeated symbol summing to a total, plus one equation mixing known symbols
// with the target symbol
const solveEquationSystem = (block, targetSymbol) => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const equations = [];
    for (const line of lines) {
        const m = line.match(/^([^\s=]+(?:\s*\+\s*[^\s=]+)*)\s*=\s*(-?\d+(?:\.\d+)?)$/);
        if (!m) continue;
        const symbols = m[1].split('+').map(s => s.trim());
        equations.push({ symbols, total: parseFloat(m[2]) });
    }
    if (equations.length === 0) return null;

    const knownValues = {};
    let targetLine = null;
    for (const eq of equations) {
        const unique = new Set(eq.symbols);
        if (unique.size === 1 && !eq.symbols.includes(targetSymbol)) {
            knownValues[eq.symbols[0]] = eq.total / eq.symbols.length;
        } else if (eq.symbols.includes(targetSymbol)) {
            targetLine = eq;
        }
    }
    if (!targetLine) return null;

    let remaining = targetLine.total;
    let targetCount = 0;
    for (const symbol of targetLine.symbols) {
        if (symbol === targetSymbol) { targetCount++; continue; }
        if (!(symbol in knownValues)) return null; // unresolved dependency
        remaining -= knownValues[symbol];
    }
    if (targetCount === 0) return null;
    const value = remaining / targetCount;
    return String(Math.round(value * 1e6) / 1e6);
};

const findDictionaryMatch = (pattern, mode) => {
    const candidates = [];
    for (const word of words) {
        if (word.length !== pattern.length) continue;
        if (mode === 'fill') {
            let matches = true;
            for (let i = 0; i < pattern.length; i++) {
                if (pattern[i] === '_') continue;
                if (pattern[i].toLowerCase() !== word[i].toLowerCase()) { matches = false; break; }
            }
            if (matches) candidates.push(word);
        } else {
            const sortedPattern = pattern.toLowerCase().split('').sort().join('');
            const sortedWord = word.toLowerCase().split('').sort().join('');
            if (sortedPattern === sortedWord) candidates.push(word);
        }
    }
    return candidates.length === 1 ? candidates[0] : null;
};

const solve = (block) => {
    if (knownAnswers.has(block)) return knownAnswers.get(block);

    const solveForMatch = block.match(/solve for: `([^`]+)`/i);
    if (solveForMatch) return solveEquationSystem(block, solveForMatch[1]);

    const prompt = extractPrompt(block);
    if (!prompt) return null;
    const { verb, value } = prompt;

    if (verb.startsWith('write out')) return value; // answer is given verbatim
    if (verb.startsWith('solve')) {
        const result = evaluateArithmetic(value);
        return result == null ? null : String(result);
    }
    if (verb.startsWith('fill in the word')) return findDictionaryMatch(value, 'fill');
    if (verb.startsWith('unscramble')) return findDictionaryMatch(value, 'unscramble');
    if (verb.startsWith('answer')) {
        // plain trivia question - not algorithmically solvable, only known
        // if this exact question has been manually taught in
        // chatgame-trivia.json (mirrors the "Answer: X" workflow for
        // chatgames.txt, but keyed by question text so it works no matter
        // how much other noise the buffering window sweeps in around it)
        return trivia.get(normalizeTriviaQuestion(value)) || null;
    }
    return null;
};

module.exports = { solve, learnFromAnnouncement };
