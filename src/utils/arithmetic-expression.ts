// Parse numeric tick-delay expressions without executing browser JavaScript.
export function evaluateExpression(value: unknown): number | 'invalid_input' {
    if (typeof value !== 'string' || !value.trim() || value.length > 512) return 'invalid_input';
    const tokens: string[] = [];
    let text = value.trim();
    while (text) {
        const token = /^(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|\*\*|[()+\-*/%])/.exec(text)?.[0];
        if (!token || tokens.length >= 256) return 'invalid_input';
        tokens.push(token);
        text = text.slice(token.length).trimStart();
    }
    let at = 0;
    const primary = (): number => {
        if (tokens[at] === '(') {
            at++;
            const result = sum();
            if (tokens[at++] !== ')') throw new Error('Unbalanced expression');
            return result;
        }
        const token = tokens[at++];
        if (!token || !/^(?:\d|\.)/.test(token)) throw new Error('Number expected');
        return Number(token);
    };
    const power = (): number => {
        const left = primary();
        if (tokens[at] !== '**') return left;
        at++;
        return left ** unary();
    };
    const unary = (): number => {
        const operator = tokens[at];
        if (operator !== '+' && operator !== '-') return power();
        at++;
        return (operator === '-' ? -1 : 1) * unary();
    };
    const product = (): number => {
        let result = unary();
        while (['*', '/', '%'].includes(tokens[at])) {
            const operator = tokens[at++],
                right = unary();
            result = operator === '*' ? result * right : operator === '/' ? result / right : result % right;
        }
        return result;
    };
    const sum = (): number => {
        let result = product();
        while (tokens[at] === '+' || tokens[at] === '-') {
            const operator = tokens[at++],
                right = product();
            result = operator === '+' ? result + right : result - right;
        }
        return result;
    };
    try {
        const result = sum();
        return at === tokens.length && Number.isFinite(result) ? result : 'invalid_input';
    } catch {
        return 'invalid_input';
    }
}
