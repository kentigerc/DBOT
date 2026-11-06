import { evaluateExpression } from '../arithmetic-expression';
it.each([
    ['2+3*4', 14],
    ['(2+3)*4', 20],
    ['2**3**2', 512],
    ['-2 + 5', 3],
    ['1e2 / 5', 20],
    ['.5 * 2', 1],
    ['8%3', 2],
    ['2**-2', 0.25],
])('evaluates numeric arithmetic %s', (value, expected) => expect(evaluateExpression(value)).toBe(expected));
it.each([
    'globalThis.alert(1)',
    '(globalThis.__neto_security_probe = 1)',
    '(()=>1)()',
    '1; alert(1)',
    'constructor.constructor("return 1")()',
    '2 + x',
    '<script>1</script>',
    '1/0',
    '0/0',
    '2/**/3',
    '1'.repeat(513),
])('rejects executable or invalid input: %s', input => {
    expect(evaluateExpression(input)).toBe('invalid_input');
    expect((globalThis as any).__neto_security_probe).toBeUndefined();
});
