// Acorn 0.4 inside @deriv/js-interpreter generates a keyword predicate with
// Function. Replace only that fixed optimization with equivalent membership
// lookup, so importing the interpreter works under a no-eval CSP.
module.exports = function cspInterpreter(source) {
    const needle = 'return new Function("str", f);';
    if (source.split(needle).length !== 2)
        throw new Error('Review the interpreter CSP transform for this dependency version.');
    return source.replace(needle, 'return function(str) { return words.indexOf(str) !== -1; };');
};
