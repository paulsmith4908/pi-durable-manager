var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/highlight.js/lib/core.js
var require_core = __commonJS({
  "node_modules/highlight.js/lib/core.js"(exports, module) {
    function deepFreeze(obj) {
      if (obj instanceof Map) {
        obj.clear = obj.delete = obj.set = function() {
          throw new Error("map is read-only");
        };
      } else if (obj instanceof Set) {
        obj.add = obj.clear = obj.delete = function() {
          throw new Error("set is read-only");
        };
      }
      Object.freeze(obj);
      Object.getOwnPropertyNames(obj).forEach(function(name) {
        var prop = obj[name];
        if (typeof prop == "object" && !Object.isFrozen(prop)) {
          deepFreeze(prop);
        }
      });
      return obj;
    }
    var deepFreezeEs6 = deepFreeze;
    var _default = deepFreeze;
    deepFreezeEs6.default = _default;
    var Response = class {
      /**
       * @param {CompiledMode} mode
       */
      constructor(mode) {
        if (mode.data === void 0) mode.data = {};
        this.data = mode.data;
        this.isMatchIgnored = false;
      }
      ignoreMatch() {
        this.isMatchIgnored = true;
      }
    };
    function escapeHTML(value) {
      return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
    }
    function inherit(original, ...objects) {
      const result = /* @__PURE__ */ Object.create(null);
      for (const key in original) {
        result[key] = original[key];
      }
      objects.forEach(function(obj) {
        for (const key in obj) {
          result[key] = obj[key];
        }
      });
      return (
        /** @type {T} */
        result
      );
    }
    var SPAN_CLOSE2 = "</span>";
    var emitsWrappingTags = (node) => {
      return !!node.kind;
    };
    var HTMLRenderer = class {
      /**
       * Creates a new HTMLRenderer
       *
       * @param {Tree} parseTree - the parse tree (must support `walk` API)
       * @param {{classPrefix: string}} options
       */
      constructor(parseTree, options) {
        this.buffer = "";
        this.classPrefix = options.classPrefix;
        parseTree.walk(this);
      }
      /**
       * Adds texts to the output stream
       *
       * @param {string} text */
      addText(text) {
        this.buffer += escapeHTML(text);
      }
      /**
       * Adds a node open to the output stream (if needed)
       *
       * @param {Node} node */
      openNode(node) {
        if (!emitsWrappingTags(node)) return;
        let className = node.kind;
        if (!node.sublanguage) {
          className = `${this.classPrefix}${className}`;
        }
        this.span(className);
      }
      /**
       * Adds a node close to the output stream (if needed)
       *
       * @param {Node} node */
      closeNode(node) {
        if (!emitsWrappingTags(node)) return;
        this.buffer += SPAN_CLOSE2;
      }
      /**
       * returns the accumulated buffer
      */
      value() {
        return this.buffer;
      }
      // helpers
      /**
       * Builds a span element
       *
       * @param {string} className */
      span(className) {
        this.buffer += `<span class="${className}">`;
      }
    };
    var TokenTree = class _TokenTree {
      constructor() {
        this.rootNode = { children: [] };
        this.stack = [this.rootNode];
      }
      get top() {
        return this.stack[this.stack.length - 1];
      }
      get root() {
        return this.rootNode;
      }
      /** @param {Node} node */
      add(node) {
        this.top.children.push(node);
      }
      /** @param {string} kind */
      openNode(kind) {
        const node = { kind, children: [] };
        this.add(node);
        this.stack.push(node);
      }
      closeNode() {
        if (this.stack.length > 1) {
          return this.stack.pop();
        }
        return void 0;
      }
      closeAllNodes() {
        while (this.closeNode()) ;
      }
      toJSON() {
        return JSON.stringify(this.rootNode, null, 4);
      }
      /**
       * @typedef { import("./html_renderer").Renderer } Renderer
       * @param {Renderer} builder
       */
      walk(builder) {
        return this.constructor._walk(builder, this.rootNode);
      }
      /**
       * @param {Renderer} builder
       * @param {Node} node
       */
      static _walk(builder, node) {
        if (typeof node === "string") {
          builder.addText(node);
        } else if (node.children) {
          builder.openNode(node);
          node.children.forEach((child) => this._walk(builder, child));
          builder.closeNode(node);
        }
        return builder;
      }
      /**
       * @param {Node} node
       */
      static _collapse(node) {
        if (typeof node === "string") return;
        if (!node.children) return;
        if (node.children.every((el) => typeof el === "string")) {
          node.children = [node.children.join("")];
        } else {
          node.children.forEach((child) => {
            _TokenTree._collapse(child);
          });
        }
      }
    };
    var TokenTreeEmitter = class extends TokenTree {
      /**
       * @param {*} options
       */
      constructor(options) {
        super();
        this.options = options;
      }
      /**
       * @param {string} text
       * @param {string} kind
       */
      addKeyword(text, kind) {
        if (text === "") {
          return;
        }
        this.openNode(kind);
        this.addText(text);
        this.closeNode();
      }
      /**
       * @param {string} text
       */
      addText(text) {
        if (text === "") {
          return;
        }
        this.add(text);
      }
      /**
       * @param {Emitter & {root: DataNode}} emitter
       * @param {string} name
       */
      addSublanguage(emitter, name) {
        const node = emitter.root;
        node.kind = name;
        node.sublanguage = true;
        this.add(node);
      }
      toHTML() {
        const renderer = new HTMLRenderer(this, this.options);
        return renderer.value();
      }
      finalize() {
        return true;
      }
    };
    function escape(value) {
      return new RegExp(value.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "m");
    }
    function source(re) {
      if (!re) return null;
      if (typeof re === "string") return re;
      return re.source;
    }
    function concat(...args) {
      const joined = args.map((x) => source(x)).join("");
      return joined;
    }
    function either(...args) {
      const joined = "(" + args.map((x) => source(x)).join("|") + ")";
      return joined;
    }
    function countMatchGroups(re) {
      return new RegExp(re.toString() + "|").exec("").length - 1;
    }
    function startsWith(re, lexeme) {
      const match = re && re.exec(lexeme);
      return match && match.index === 0;
    }
    var BACKREF_RE = /\[(?:[^\\\]]|\\.)*\]|\(\??|\\([1-9][0-9]*)|\\./;
    function join2(regexps, separator = "|") {
      let numCaptures = 0;
      return regexps.map((regex) => {
        numCaptures += 1;
        const offset = numCaptures;
        let re = source(regex);
        let out = "";
        while (re.length > 0) {
          const match = BACKREF_RE.exec(re);
          if (!match) {
            out += re;
            break;
          }
          out += re.substring(0, match.index);
          re = re.substring(match.index + match[0].length);
          if (match[0][0] === "\\" && match[1]) {
            out += "\\" + String(Number(match[1]) + offset);
          } else {
            out += match[0];
            if (match[0] === "(") {
              numCaptures++;
            }
          }
        }
        return out;
      }).map((re) => `(${re})`).join(separator);
    }
    var MATCH_NOTHING_RE = /\b\B/;
    var IDENT_RE = "[a-zA-Z]\\w*";
    var UNDERSCORE_IDENT_RE = "[a-zA-Z_]\\w*";
    var NUMBER_RE = "\\b\\d+(\\.\\d+)?";
    var C_NUMBER_RE = "(-?)(\\b0[xX][a-fA-F0-9]+|(\\b\\d+(\\.\\d*)?|\\.\\d+)([eE][-+]?\\d+)?)";
    var BINARY_NUMBER_RE = "\\b(0b[01]+)";
    var RE_STARTERS_RE = "!|!=|!==|%|%=|&|&&|&=|\\*|\\*=|\\+|\\+=|,|-|-=|/=|/|:|;|<<|<<=|<=|<|===|==|=|>>>=|>>=|>=|>>>|>>|>|\\?|\\[|\\{|\\(|\\^|\\^=|\\||\\|=|\\|\\||~";
    var SHEBANG = (opts = {}) => {
      const beginShebang = /^#![ ]*\//;
      if (opts.binary) {
        opts.begin = concat(
          beginShebang,
          /.*\b/,
          opts.binary,
          /\b.*/
        );
      }
      return inherit({
        className: "meta",
        begin: beginShebang,
        end: /$/,
        relevance: 0,
        /** @type {ModeCallback} */
        "on:begin": (m, resp) => {
          if (m.index !== 0) resp.ignoreMatch();
        }
      }, opts);
    };
    var BACKSLASH_ESCAPE = {
      begin: "\\\\[\\s\\S]",
      relevance: 0
    };
    var APOS_STRING_MODE = {
      className: "string",
      begin: "'",
      end: "'",
      illegal: "\\n",
      contains: [BACKSLASH_ESCAPE]
    };
    var QUOTE_STRING_MODE = {
      className: "string",
      begin: '"',
      end: '"',
      illegal: "\\n",
      contains: [BACKSLASH_ESCAPE]
    };
    var PHRASAL_WORDS_MODE = {
      begin: /\b(a|an|the|are|I'm|isn't|don't|doesn't|won't|but|just|should|pretty|simply|enough|gonna|going|wtf|so|such|will|you|your|they|like|more)\b/
    };
    var COMMENT = function(begin, end, modeOptions = {}) {
      const mode = inherit(
        {
          className: "comment",
          begin,
          end,
          contains: []
        },
        modeOptions
      );
      mode.contains.push(PHRASAL_WORDS_MODE);
      mode.contains.push({
        className: "doctag",
        begin: "(?:TODO|FIXME|NOTE|BUG|OPTIMIZE|HACK|XXX):",
        relevance: 0
      });
      return mode;
    };
    var C_LINE_COMMENT_MODE = COMMENT("//", "$");
    var C_BLOCK_COMMENT_MODE = COMMENT("/\\*", "\\*/");
    var HASH_COMMENT_MODE = COMMENT("#", "$");
    var NUMBER_MODE = {
      className: "number",
      begin: NUMBER_RE,
      relevance: 0
    };
    var C_NUMBER_MODE = {
      className: "number",
      begin: C_NUMBER_RE,
      relevance: 0
    };
    var BINARY_NUMBER_MODE = {
      className: "number",
      begin: BINARY_NUMBER_RE,
      relevance: 0
    };
    var CSS_NUMBER_MODE = {
      className: "number",
      begin: NUMBER_RE + "(%|em|ex|ch|rem|vw|vh|vmin|vmax|cm|mm|in|pt|pc|px|deg|grad|rad|turn|s|ms|Hz|kHz|dpi|dpcm|dppx)?",
      relevance: 0
    };
    var REGEXP_MODE = {
      // this outer rule makes sure we actually have a WHOLE regex and not simply
      // an expression such as:
      //
      //     3 / something
      //
      // (which will then blow up when regex's `illegal` sees the newline)
      begin: /(?=\/[^/\n]*\/)/,
      contains: [{
        className: "regexp",
        begin: /\//,
        end: /\/[gimuy]*/,
        illegal: /\n/,
        contains: [
          BACKSLASH_ESCAPE,
          {
            begin: /\[/,
            end: /\]/,
            relevance: 0,
            contains: [BACKSLASH_ESCAPE]
          }
        ]
      }]
    };
    var TITLE_MODE = {
      className: "title",
      begin: IDENT_RE,
      relevance: 0
    };
    var UNDERSCORE_TITLE_MODE = {
      className: "title",
      begin: UNDERSCORE_IDENT_RE,
      relevance: 0
    };
    var METHOD_GUARD = {
      // excludes method names from keyword processing
      begin: "\\.\\s*" + UNDERSCORE_IDENT_RE,
      relevance: 0
    };
    var END_SAME_AS_BEGIN = function(mode) {
      return Object.assign(
        mode,
        {
          /** @type {ModeCallback} */
          "on:begin": (m, resp) => {
            resp.data._beginMatch = m[1];
          },
          /** @type {ModeCallback} */
          "on:end": (m, resp) => {
            if (resp.data._beginMatch !== m[1]) resp.ignoreMatch();
          }
        }
      );
    };
    var MODES = /* @__PURE__ */ Object.freeze({
      __proto__: null,
      MATCH_NOTHING_RE,
      IDENT_RE,
      UNDERSCORE_IDENT_RE,
      NUMBER_RE,
      C_NUMBER_RE,
      BINARY_NUMBER_RE,
      RE_STARTERS_RE,
      SHEBANG,
      BACKSLASH_ESCAPE,
      APOS_STRING_MODE,
      QUOTE_STRING_MODE,
      PHRASAL_WORDS_MODE,
      COMMENT,
      C_LINE_COMMENT_MODE,
      C_BLOCK_COMMENT_MODE,
      HASH_COMMENT_MODE,
      NUMBER_MODE,
      C_NUMBER_MODE,
      BINARY_NUMBER_MODE,
      CSS_NUMBER_MODE,
      REGEXP_MODE,
      TITLE_MODE,
      UNDERSCORE_TITLE_MODE,
      METHOD_GUARD,
      END_SAME_AS_BEGIN
    });
    function skipIfhasPrecedingDot(match, response) {
      const before = match.input[match.index - 1];
      if (before === ".") {
        response.ignoreMatch();
      }
    }
    function beginKeywords(mode, parent) {
      if (!parent) return;
      if (!mode.beginKeywords) return;
      mode.begin = "\\b(" + mode.beginKeywords.split(" ").join("|") + ")(?!\\.)(?=\\b|\\s)";
      mode.__beforeBegin = skipIfhasPrecedingDot;
      mode.keywords = mode.keywords || mode.beginKeywords;
      delete mode.beginKeywords;
      if (mode.relevance === void 0) mode.relevance = 0;
    }
    function compileIllegal(mode, _parent) {
      if (!Array.isArray(mode.illegal)) return;
      mode.illegal = either(...mode.illegal);
    }
    function compileMatch(mode, _parent) {
      if (!mode.match) return;
      if (mode.begin || mode.end) throw new Error("begin & end are not supported with match");
      mode.begin = mode.match;
      delete mode.match;
    }
    function compileRelevance(mode, _parent) {
      if (mode.relevance === void 0) mode.relevance = 1;
    }
    var COMMON_KEYWORDS = [
      "of",
      "and",
      "for",
      "in",
      "not",
      "or",
      "if",
      "then",
      "parent",
      // common variable name
      "list",
      // common variable name
      "value"
      // common variable name
    ];
    var DEFAULT_KEYWORD_CLASSNAME = "keyword";
    function compileKeywords(rawKeywords, caseInsensitive, className = DEFAULT_KEYWORD_CLASSNAME) {
      const compiledKeywords = {};
      if (typeof rawKeywords === "string") {
        compileList(className, rawKeywords.split(" "));
      } else if (Array.isArray(rawKeywords)) {
        compileList(className, rawKeywords);
      } else {
        Object.keys(rawKeywords).forEach(function(className2) {
          Object.assign(
            compiledKeywords,
            compileKeywords(rawKeywords[className2], caseInsensitive, className2)
          );
        });
      }
      return compiledKeywords;
      function compileList(className2, keywordList) {
        if (caseInsensitive) {
          keywordList = keywordList.map((x) => x.toLowerCase());
        }
        keywordList.forEach(function(keyword) {
          const pair = keyword.split("|");
          compiledKeywords[pair[0]] = [className2, scoreForKeyword(pair[0], pair[1])];
        });
      }
    }
    function scoreForKeyword(keyword, providedScore) {
      if (providedScore) {
        return Number(providedScore);
      }
      return commonKeyword(keyword) ? 0 : 1;
    }
    function commonKeyword(keyword) {
      return COMMON_KEYWORDS.includes(keyword.toLowerCase());
    }
    function compileLanguage(language, { plugins }) {
      function langRe(value, global) {
        return new RegExp(
          source(value),
          "m" + (language.case_insensitive ? "i" : "") + (global ? "g" : "")
        );
      }
      class MultiRegex {
        constructor() {
          this.matchIndexes = {};
          this.regexes = [];
          this.matchAt = 1;
          this.position = 0;
        }
        // @ts-ignore
        addRule(re, opts) {
          opts.position = this.position++;
          this.matchIndexes[this.matchAt] = opts;
          this.regexes.push([opts, re]);
          this.matchAt += countMatchGroups(re) + 1;
        }
        compile() {
          if (this.regexes.length === 0) {
            this.exec = () => null;
          }
          const terminators = this.regexes.map((el) => el[1]);
          this.matcherRe = langRe(join2(terminators), true);
          this.lastIndex = 0;
        }
        /** @param {string} s */
        exec(s) {
          this.matcherRe.lastIndex = this.lastIndex;
          const match = this.matcherRe.exec(s);
          if (!match) {
            return null;
          }
          const i = match.findIndex((el, i2) => i2 > 0 && el !== void 0);
          const matchData = this.matchIndexes[i];
          match.splice(0, i);
          return Object.assign(match, matchData);
        }
      }
      class ResumableMultiRegex {
        constructor() {
          this.rules = [];
          this.multiRegexes = [];
          this.count = 0;
          this.lastIndex = 0;
          this.regexIndex = 0;
        }
        // @ts-ignore
        getMatcher(index) {
          if (this.multiRegexes[index]) return this.multiRegexes[index];
          const matcher = new MultiRegex();
          this.rules.slice(index).forEach(([re, opts]) => matcher.addRule(re, opts));
          matcher.compile();
          this.multiRegexes[index] = matcher;
          return matcher;
        }
        resumingScanAtSamePosition() {
          return this.regexIndex !== 0;
        }
        considerAll() {
          this.regexIndex = 0;
        }
        // @ts-ignore
        addRule(re, opts) {
          this.rules.push([re, opts]);
          if (opts.type === "begin") this.count++;
        }
        /** @param {string} s */
        exec(s) {
          const m = this.getMatcher(this.regexIndex);
          m.lastIndex = this.lastIndex;
          let result = m.exec(s);
          if (this.resumingScanAtSamePosition()) {
            if (result && result.index === this.lastIndex) ;
            else {
              const m2 = this.getMatcher(0);
              m2.lastIndex = this.lastIndex + 1;
              result = m2.exec(s);
            }
          }
          if (result) {
            this.regexIndex += result.position + 1;
            if (this.regexIndex === this.count) {
              this.considerAll();
            }
          }
          return result;
        }
      }
      function buildModeRegex(mode) {
        const mm = new ResumableMultiRegex();
        mode.contains.forEach((term) => mm.addRule(term.begin, { rule: term, type: "begin" }));
        if (mode.terminatorEnd) {
          mm.addRule(mode.terminatorEnd, { type: "end" });
        }
        if (mode.illegal) {
          mm.addRule(mode.illegal, { type: "illegal" });
        }
        return mm;
      }
      function compileMode(mode, parent) {
        const cmode = (
          /** @type CompiledMode */
          mode
        );
        if (mode.isCompiled) return cmode;
        [
          // do this early so compiler extensions generally don't have to worry about
          // the distinction between match/begin
          compileMatch
        ].forEach((ext) => ext(mode, parent));
        language.compilerExtensions.forEach((ext) => ext(mode, parent));
        mode.__beforeBegin = null;
        [
          beginKeywords,
          // do this later so compiler extensions that come earlier have access to the
          // raw array if they wanted to perhaps manipulate it, etc.
          compileIllegal,
          // default to 1 relevance if not specified
          compileRelevance
        ].forEach((ext) => ext(mode, parent));
        mode.isCompiled = true;
        let keywordPattern = null;
        if (typeof mode.keywords === "object") {
          keywordPattern = mode.keywords.$pattern;
          delete mode.keywords.$pattern;
        }
        if (mode.keywords) {
          mode.keywords = compileKeywords(mode.keywords, language.case_insensitive);
        }
        if (mode.lexemes && keywordPattern) {
          throw new Error("ERR: Prefer `keywords.$pattern` to `mode.lexemes`, BOTH are not allowed. (see mode reference) ");
        }
        keywordPattern = keywordPattern || mode.lexemes || /\w+/;
        cmode.keywordPatternRe = langRe(keywordPattern, true);
        if (parent) {
          if (!mode.begin) mode.begin = /\B|\b/;
          cmode.beginRe = langRe(mode.begin);
          if (mode.endSameAsBegin) mode.end = mode.begin;
          if (!mode.end && !mode.endsWithParent) mode.end = /\B|\b/;
          if (mode.end) cmode.endRe = langRe(mode.end);
          cmode.terminatorEnd = source(mode.end) || "";
          if (mode.endsWithParent && parent.terminatorEnd) {
            cmode.terminatorEnd += (mode.end ? "|" : "") + parent.terminatorEnd;
          }
        }
        if (mode.illegal) cmode.illegalRe = langRe(
          /** @type {RegExp | string} */
          mode.illegal
        );
        if (!mode.contains) mode.contains = [];
        mode.contains = [].concat(...mode.contains.map(function(c2) {
          return expandOrCloneMode(c2 === "self" ? mode : c2);
        }));
        mode.contains.forEach(function(c2) {
          compileMode(
            /** @type Mode */
            c2,
            cmode
          );
        });
        if (mode.starts) {
          compileMode(mode.starts, parent);
        }
        cmode.matcher = buildModeRegex(cmode);
        return cmode;
      }
      if (!language.compilerExtensions) language.compilerExtensions = [];
      if (language.contains && language.contains.includes("self")) {
        throw new Error("ERR: contains `self` is not supported at the top-level of a language.  See documentation.");
      }
      language.classNameAliases = inherit(language.classNameAliases || {});
      return compileMode(
        /** @type Mode */
        language
      );
    }
    function dependencyOnParent(mode) {
      if (!mode) return false;
      return mode.endsWithParent || dependencyOnParent(mode.starts);
    }
    function expandOrCloneMode(mode) {
      if (mode.variants && !mode.cachedVariants) {
        mode.cachedVariants = mode.variants.map(function(variant) {
          return inherit(mode, { variants: null }, variant);
        });
      }
      if (mode.cachedVariants) {
        return mode.cachedVariants;
      }
      if (dependencyOnParent(mode)) {
        return inherit(mode, { starts: mode.starts ? inherit(mode.starts) : null });
      }
      if (Object.isFrozen(mode)) {
        return inherit(mode);
      }
      return mode;
    }
    var version = "10.7.3";
    function hasValueOrEmptyAttribute(value) {
      return Boolean(value || value === "");
    }
    function BuildVuePlugin(hljs2) {
      const Component = {
        props: ["language", "code", "autodetect"],
        data: function() {
          return {
            detectedLanguage: "",
            unknownLanguage: false
          };
        },
        computed: {
          className() {
            if (this.unknownLanguage) return "";
            return "hljs " + this.detectedLanguage;
          },
          highlighted() {
            if (!this.autoDetect && !hljs2.getLanguage(this.language)) {
              console.warn(`The language "${this.language}" you specified could not be found.`);
              this.unknownLanguage = true;
              return escapeHTML(this.code);
            }
            let result = {};
            if (this.autoDetect) {
              result = hljs2.highlightAuto(this.code);
              this.detectedLanguage = result.language;
            } else {
              result = hljs2.highlight(this.language, this.code, this.ignoreIllegals);
              this.detectedLanguage = this.language;
            }
            return result.value;
          },
          autoDetect() {
            return !this.language || hasValueOrEmptyAttribute(this.autodetect);
          },
          ignoreIllegals() {
            return true;
          }
        },
        // this avoids needing to use a whole Vue compilation pipeline just
        // to build Highlight.js
        render(createElement) {
          return createElement("pre", {}, [
            createElement("code", {
              class: this.className,
              domProps: { innerHTML: this.highlighted }
            })
          ]);
        }
        // template: `<pre><code :class="className" v-html="highlighted"></code></pre>`
      };
      const VuePlugin = {
        install(Vue) {
          Vue.component("highlightjs", Component);
        }
      };
      return { Component, VuePlugin };
    }
    var mergeHTMLPlugin = {
      "after:highlightElement": ({ el, result, text }) => {
        const originalStream = nodeStream(el);
        if (!originalStream.length) return;
        const resultNode = document.createElement("div");
        resultNode.innerHTML = result.value;
        result.value = mergeStreams(originalStream, nodeStream(resultNode), text);
      }
    };
    function tag(node) {
      return node.nodeName.toLowerCase();
    }
    function nodeStream(node) {
      const result = [];
      (function _nodeStream(node2, offset) {
        for (let child = node2.firstChild; child; child = child.nextSibling) {
          if (child.nodeType === 3) {
            offset += child.nodeValue.length;
          } else if (child.nodeType === 1) {
            result.push({
              event: "start",
              offset,
              node: child
            });
            offset = _nodeStream(child, offset);
            if (!tag(child).match(/br|hr|img|input/)) {
              result.push({
                event: "stop",
                offset,
                node: child
              });
            }
          }
        }
        return offset;
      })(node, 0);
      return result;
    }
    function mergeStreams(original, highlighted, value) {
      let processed = 0;
      let result = "";
      const nodeStack = [];
      function selectStream() {
        if (!original.length || !highlighted.length) {
          return original.length ? original : highlighted;
        }
        if (original[0].offset !== highlighted[0].offset) {
          return original[0].offset < highlighted[0].offset ? original : highlighted;
        }
        return highlighted[0].event === "start" ? original : highlighted;
      }
      function open(node) {
        function attributeString(attr) {
          return " " + attr.nodeName + '="' + escapeHTML(attr.value) + '"';
        }
        result += "<" + tag(node) + [].map.call(node.attributes, attributeString).join("") + ">";
      }
      function close(node) {
        result += "</" + tag(node) + ">";
      }
      function render(event) {
        (event.event === "start" ? open : close)(event.node);
      }
      while (original.length || highlighted.length) {
        let stream = selectStream();
        result += escapeHTML(value.substring(processed, stream[0].offset));
        processed = stream[0].offset;
        if (stream === original) {
          nodeStack.reverse().forEach(close);
          do {
            render(stream.splice(0, 1)[0]);
            stream = selectStream();
          } while (stream === original && stream.length && stream[0].offset === processed);
          nodeStack.reverse().forEach(open);
        } else {
          if (stream[0].event === "start") {
            nodeStack.push(stream[0].node);
          } else {
            nodeStack.pop();
          }
          render(stream.splice(0, 1)[0]);
        }
      }
      return result + escapeHTML(value.substr(processed));
    }
    var seenDeprecations = {};
    var error = (message) => {
      console.error(message);
    };
    var warn = (message, ...args) => {
      console.log(`WARN: ${message}`, ...args);
    };
    var deprecated = (version2, message) => {
      if (seenDeprecations[`${version2}/${message}`]) return;
      console.log(`Deprecated as of ${version2}. ${message}`);
      seenDeprecations[`${version2}/${message}`] = true;
    };
    var escape$1 = escapeHTML;
    var inherit$1 = inherit;
    var NO_MATCH = Symbol("nomatch");
    var HLJS = function(hljs2) {
      const languages = /* @__PURE__ */ Object.create(null);
      const aliases = /* @__PURE__ */ Object.create(null);
      const plugins = [];
      let SAFE_MODE = true;
      const fixMarkupRe = /(^(<[^>]+>|\t|)+|\n)/gm;
      const LANGUAGE_NOT_FOUND = "Could not find the language '{}', did you forget to load/include a language module?";
      const PLAINTEXT_LANGUAGE = { disableAutodetect: true, name: "Plain text", contains: [] };
      let options = {
        noHighlightRe: /^(no-?highlight)$/i,
        languageDetectRe: /\blang(?:uage)?-([\w-]+)\b/i,
        classPrefix: "hljs-",
        tabReplace: null,
        useBR: false,
        languages: null,
        // beta configuration options, subject to change, welcome to discuss
        // https://github.com/highlightjs/highlight.js/issues/1086
        __emitter: TokenTreeEmitter
      };
      function shouldNotHighlight(languageName) {
        return options.noHighlightRe.test(languageName);
      }
      function blockLanguage(block) {
        let classes = block.className + " ";
        classes += block.parentNode ? block.parentNode.className : "";
        const match = options.languageDetectRe.exec(classes);
        if (match) {
          const language = getLanguage(match[1]);
          if (!language) {
            warn(LANGUAGE_NOT_FOUND.replace("{}", match[1]));
            warn("Falling back to no-highlight mode for this block.", block);
          }
          return language ? match[1] : "no-highlight";
        }
        return classes.split(/\s+/).find((_class) => shouldNotHighlight(_class) || getLanguage(_class));
      }
      function highlight3(codeOrlanguageName, optionsOrCode, ignoreIllegals, continuation) {
        let code = "";
        let languageName = "";
        if (typeof optionsOrCode === "object") {
          code = codeOrlanguageName;
          ignoreIllegals = optionsOrCode.ignoreIllegals;
          languageName = optionsOrCode.language;
          continuation = void 0;
        } else {
          deprecated("10.7.0", "highlight(lang, code, ...args) has been deprecated.");
          deprecated("10.7.0", "Please use highlight(code, options) instead.\nhttps://github.com/highlightjs/highlight.js/issues/2277");
          languageName = codeOrlanguageName;
          code = optionsOrCode;
        }
        const context = {
          code,
          language: languageName
        };
        fire("before:highlight", context);
        const result = context.result ? context.result : _highlight(context.language, context.code, ignoreIllegals, continuation);
        result.code = context.code;
        fire("after:highlight", result);
        return result;
      }
      function _highlight(languageName, codeToHighlight, ignoreIllegals, continuation) {
        function keywordData(mode, match) {
          const matchText = language.case_insensitive ? match[0].toLowerCase() : match[0];
          return Object.prototype.hasOwnProperty.call(mode.keywords, matchText) && mode.keywords[matchText];
        }
        function processKeywords() {
          if (!top.keywords) {
            emitter.addText(modeBuffer);
            return;
          }
          let lastIndex = 0;
          top.keywordPatternRe.lastIndex = 0;
          let match = top.keywordPatternRe.exec(modeBuffer);
          let buf = "";
          while (match) {
            buf += modeBuffer.substring(lastIndex, match.index);
            const data = keywordData(top, match);
            if (data) {
              const [kind, keywordRelevance] = data;
              emitter.addText(buf);
              buf = "";
              relevance += keywordRelevance;
              if (kind.startsWith("_")) {
                buf += match[0];
              } else {
                const cssClass = language.classNameAliases[kind] || kind;
                emitter.addKeyword(match[0], cssClass);
              }
            } else {
              buf += match[0];
            }
            lastIndex = top.keywordPatternRe.lastIndex;
            match = top.keywordPatternRe.exec(modeBuffer);
          }
          buf += modeBuffer.substr(lastIndex);
          emitter.addText(buf);
        }
        function processSubLanguage() {
          if (modeBuffer === "") return;
          let result2 = null;
          if (typeof top.subLanguage === "string") {
            if (!languages[top.subLanguage]) {
              emitter.addText(modeBuffer);
              return;
            }
            result2 = _highlight(top.subLanguage, modeBuffer, true, continuations[top.subLanguage]);
            continuations[top.subLanguage] = /** @type {CompiledMode} */
            result2.top;
          } else {
            result2 = highlightAuto(modeBuffer, top.subLanguage.length ? top.subLanguage : null);
          }
          if (top.relevance > 0) {
            relevance += result2.relevance;
          }
          emitter.addSublanguage(result2.emitter, result2.language);
        }
        function processBuffer() {
          if (top.subLanguage != null) {
            processSubLanguage();
          } else {
            processKeywords();
          }
          modeBuffer = "";
        }
        function startNewMode(mode) {
          if (mode.className) {
            emitter.openNode(language.classNameAliases[mode.className] || mode.className);
          }
          top = Object.create(mode, { parent: { value: top } });
          return top;
        }
        function endOfMode(mode, match, matchPlusRemainder) {
          let matched = startsWith(mode.endRe, matchPlusRemainder);
          if (matched) {
            if (mode["on:end"]) {
              const resp = new Response(mode);
              mode["on:end"](match, resp);
              if (resp.isMatchIgnored) matched = false;
            }
            if (matched) {
              while (mode.endsParent && mode.parent) {
                mode = mode.parent;
              }
              return mode;
            }
          }
          if (mode.endsWithParent) {
            return endOfMode(mode.parent, match, matchPlusRemainder);
          }
        }
        function doIgnore(lexeme) {
          if (top.matcher.regexIndex === 0) {
            modeBuffer += lexeme[0];
            return 1;
          } else {
            resumeScanAtSamePosition = true;
            return 0;
          }
        }
        function doBeginMatch(match) {
          const lexeme = match[0];
          const newMode = match.rule;
          const resp = new Response(newMode);
          const beforeCallbacks = [newMode.__beforeBegin, newMode["on:begin"]];
          for (const cb of beforeCallbacks) {
            if (!cb) continue;
            cb(match, resp);
            if (resp.isMatchIgnored) return doIgnore(lexeme);
          }
          if (newMode && newMode.endSameAsBegin) {
            newMode.endRe = escape(lexeme);
          }
          if (newMode.skip) {
            modeBuffer += lexeme;
          } else {
            if (newMode.excludeBegin) {
              modeBuffer += lexeme;
            }
            processBuffer();
            if (!newMode.returnBegin && !newMode.excludeBegin) {
              modeBuffer = lexeme;
            }
          }
          startNewMode(newMode);
          return newMode.returnBegin ? 0 : lexeme.length;
        }
        function doEndMatch(match) {
          const lexeme = match[0];
          const matchPlusRemainder = codeToHighlight.substr(match.index);
          const endMode = endOfMode(top, match, matchPlusRemainder);
          if (!endMode) {
            return NO_MATCH;
          }
          const origin = top;
          if (origin.skip) {
            modeBuffer += lexeme;
          } else {
            if (!(origin.returnEnd || origin.excludeEnd)) {
              modeBuffer += lexeme;
            }
            processBuffer();
            if (origin.excludeEnd) {
              modeBuffer = lexeme;
            }
          }
          do {
            if (top.className) {
              emitter.closeNode();
            }
            if (!top.skip && !top.subLanguage) {
              relevance += top.relevance;
            }
            top = top.parent;
          } while (top !== endMode.parent);
          if (endMode.starts) {
            if (endMode.endSameAsBegin) {
              endMode.starts.endRe = endMode.endRe;
            }
            startNewMode(endMode.starts);
          }
          return origin.returnEnd ? 0 : lexeme.length;
        }
        function processContinuations() {
          const list = [];
          for (let current = top; current !== language; current = current.parent) {
            if (current.className) {
              list.unshift(current.className);
            }
          }
          list.forEach((item) => emitter.openNode(item));
        }
        let lastMatch = {};
        function processLexeme(textBeforeMatch, match) {
          const lexeme = match && match[0];
          modeBuffer += textBeforeMatch;
          if (lexeme == null) {
            processBuffer();
            return 0;
          }
          if (lastMatch.type === "begin" && match.type === "end" && lastMatch.index === match.index && lexeme === "") {
            modeBuffer += codeToHighlight.slice(match.index, match.index + 1);
            if (!SAFE_MODE) {
              const err = new Error("0 width match regex");
              err.languageName = languageName;
              err.badRule = lastMatch.rule;
              throw err;
            }
            return 1;
          }
          lastMatch = match;
          if (match.type === "begin") {
            return doBeginMatch(match);
          } else if (match.type === "illegal" && !ignoreIllegals) {
            const err = new Error('Illegal lexeme "' + lexeme + '" for mode "' + (top.className || "<unnamed>") + '"');
            err.mode = top;
            throw err;
          } else if (match.type === "end") {
            const processed = doEndMatch(match);
            if (processed !== NO_MATCH) {
              return processed;
            }
          }
          if (match.type === "illegal" && lexeme === "") {
            return 1;
          }
          if (iterations > 1e5 && iterations > match.index * 3) {
            const err = new Error("potential infinite loop, way more iterations than matches");
            throw err;
          }
          modeBuffer += lexeme;
          return lexeme.length;
        }
        const language = getLanguage(languageName);
        if (!language) {
          error(LANGUAGE_NOT_FOUND.replace("{}", languageName));
          throw new Error('Unknown language: "' + languageName + '"');
        }
        const md = compileLanguage(language, { plugins });
        let result = "";
        let top = continuation || md;
        const continuations = {};
        const emitter = new options.__emitter(options);
        processContinuations();
        let modeBuffer = "";
        let relevance = 0;
        let index = 0;
        let iterations = 0;
        let resumeScanAtSamePosition = false;
        try {
          top.matcher.considerAll();
          for (; ; ) {
            iterations++;
            if (resumeScanAtSamePosition) {
              resumeScanAtSamePosition = false;
            } else {
              top.matcher.considerAll();
            }
            top.matcher.lastIndex = index;
            const match = top.matcher.exec(codeToHighlight);
            if (!match) break;
            const beforeMatch = codeToHighlight.substring(index, match.index);
            const processedCount = processLexeme(beforeMatch, match);
            index = match.index + processedCount;
          }
          processLexeme(codeToHighlight.substr(index));
          emitter.closeAllNodes();
          emitter.finalize();
          result = emitter.toHTML();
          return {
            // avoid possible breakage with v10 clients expecting
            // this to always be an integer
            relevance: Math.floor(relevance),
            value: result,
            language: languageName,
            illegal: false,
            emitter,
            top
          };
        } catch (err) {
          if (err.message && err.message.includes("Illegal")) {
            return {
              illegal: true,
              illegalBy: {
                msg: err.message,
                context: codeToHighlight.slice(index - 100, index + 100),
                mode: err.mode
              },
              sofar: result,
              relevance: 0,
              value: escape$1(codeToHighlight),
              emitter
            };
          } else if (SAFE_MODE) {
            return {
              illegal: false,
              relevance: 0,
              value: escape$1(codeToHighlight),
              emitter,
              language: languageName,
              top,
              errorRaised: err
            };
          } else {
            throw err;
          }
        }
      }
      function justTextHighlightResult(code) {
        const result = {
          relevance: 0,
          emitter: new options.__emitter(options),
          value: escape$1(code),
          illegal: false,
          top: PLAINTEXT_LANGUAGE
        };
        result.emitter.addText(code);
        return result;
      }
      function highlightAuto(code, languageSubset) {
        languageSubset = languageSubset || options.languages || Object.keys(languages);
        const plaintext = justTextHighlightResult(code);
        const results = languageSubset.filter(getLanguage).filter(autoDetection).map(
          (name) => _highlight(name, code, false)
        );
        results.unshift(plaintext);
        const sorted = results.sort((a, b) => {
          if (a.relevance !== b.relevance) return b.relevance - a.relevance;
          if (a.language && b.language) {
            if (getLanguage(a.language).supersetOf === b.language) {
              return 1;
            } else if (getLanguage(b.language).supersetOf === a.language) {
              return -1;
            }
          }
          return 0;
        });
        const [best, secondBest] = sorted;
        const result = best;
        result.second_best = secondBest;
        return result;
      }
      function fixMarkup(html) {
        if (!(options.tabReplace || options.useBR)) {
          return html;
        }
        return html.replace(fixMarkupRe, (match) => {
          if (match === "\n") {
            return options.useBR ? "<br>" : match;
          } else if (options.tabReplace) {
            return match.replace(/\t/g, options.tabReplace);
          }
          return match;
        });
      }
      function updateClassName(element, currentLang, resultLang) {
        const language = currentLang ? aliases[currentLang] : resultLang;
        element.classList.add("hljs");
        if (language) element.classList.add(language);
      }
      const brPlugin = {
        "before:highlightElement": ({ el }) => {
          if (options.useBR) {
            el.innerHTML = el.innerHTML.replace(/\n/g, "").replace(/<br[ /]*>/g, "\n");
          }
        },
        "after:highlightElement": ({ result }) => {
          if (options.useBR) {
            result.value = result.value.replace(/\n/g, "<br>");
          }
        }
      };
      const TAB_REPLACE_RE = /^(<[^>]+>|\t)+/gm;
      const tabReplacePlugin = {
        "after:highlightElement": ({ result }) => {
          if (options.tabReplace) {
            result.value = result.value.replace(
              TAB_REPLACE_RE,
              (m) => m.replace(/\t/g, options.tabReplace)
            );
          }
        }
      };
      function highlightElement(element) {
        let node = null;
        const language = blockLanguage(element);
        if (shouldNotHighlight(language)) return;
        fire(
          "before:highlightElement",
          { el: element, language }
        );
        node = element;
        const text = node.textContent;
        const result = language ? highlight3(text, { language, ignoreIllegals: true }) : highlightAuto(text);
        fire("after:highlightElement", { el: element, result, text });
        element.innerHTML = result.value;
        updateClassName(element, language, result.language);
        element.result = {
          language: result.language,
          // TODO: remove with version 11.0
          re: result.relevance,
          relavance: result.relevance
        };
        if (result.second_best) {
          element.second_best = {
            language: result.second_best.language,
            // TODO: remove with version 11.0
            re: result.second_best.relevance,
            relavance: result.second_best.relevance
          };
        }
      }
      function configure(userOptions) {
        if (userOptions.useBR) {
          deprecated("10.3.0", "'useBR' will be removed entirely in v11.0");
          deprecated("10.3.0", "Please see https://github.com/highlightjs/highlight.js/issues/2559");
        }
        options = inherit$1(options, userOptions);
      }
      const initHighlighting = () => {
        if (initHighlighting.called) return;
        initHighlighting.called = true;
        deprecated("10.6.0", "initHighlighting() is deprecated.  Use highlightAll() instead.");
        const blocks = document.querySelectorAll("pre code");
        blocks.forEach(highlightElement);
      };
      function initHighlightingOnLoad() {
        deprecated("10.6.0", "initHighlightingOnLoad() is deprecated.  Use highlightAll() instead.");
        wantsHighlight = true;
      }
      let wantsHighlight = false;
      function highlightAll() {
        if (document.readyState === "loading") {
          wantsHighlight = true;
          return;
        }
        const blocks = document.querySelectorAll("pre code");
        blocks.forEach(highlightElement);
      }
      function boot() {
        if (wantsHighlight) highlightAll();
      }
      if (typeof window !== "undefined" && window.addEventListener) {
        window.addEventListener("DOMContentLoaded", boot, false);
      }
      function registerLanguage(languageName, languageDefinition) {
        let lang = null;
        try {
          lang = languageDefinition(hljs2);
        } catch (error$1) {
          error("Language definition for '{}' could not be registered.".replace("{}", languageName));
          if (!SAFE_MODE) {
            throw error$1;
          } else {
            error(error$1);
          }
          lang = PLAINTEXT_LANGUAGE;
        }
        if (!lang.name) lang.name = languageName;
        languages[languageName] = lang;
        lang.rawDefinition = languageDefinition.bind(null, hljs2);
        if (lang.aliases) {
          registerAliases(lang.aliases, { languageName });
        }
      }
      function unregisterLanguage(languageName) {
        delete languages[languageName];
        for (const alias of Object.keys(aliases)) {
          if (aliases[alias] === languageName) {
            delete aliases[alias];
          }
        }
      }
      function listLanguages() {
        return Object.keys(languages);
      }
      function requireLanguage(name) {
        deprecated("10.4.0", "requireLanguage will be removed entirely in v11.");
        deprecated("10.4.0", "Please see https://github.com/highlightjs/highlight.js/pull/2844");
        const lang = getLanguage(name);
        if (lang) {
          return lang;
        }
        const err = new Error("The '{}' language is required, but not loaded.".replace("{}", name));
        throw err;
      }
      function getLanguage(name) {
        name = (name || "").toLowerCase();
        return languages[name] || languages[aliases[name]];
      }
      function registerAliases(aliasList, { languageName }) {
        if (typeof aliasList === "string") {
          aliasList = [aliasList];
        }
        aliasList.forEach((alias) => {
          aliases[alias.toLowerCase()] = languageName;
        });
      }
      function autoDetection(name) {
        const lang = getLanguage(name);
        return lang && !lang.disableAutodetect;
      }
      function upgradePluginAPI(plugin) {
        if (plugin["before:highlightBlock"] && !plugin["before:highlightElement"]) {
          plugin["before:highlightElement"] = (data) => {
            plugin["before:highlightBlock"](
              Object.assign({ block: data.el }, data)
            );
          };
        }
        if (plugin["after:highlightBlock"] && !plugin["after:highlightElement"]) {
          plugin["after:highlightElement"] = (data) => {
            plugin["after:highlightBlock"](
              Object.assign({ block: data.el }, data)
            );
          };
        }
      }
      function addPlugin(plugin) {
        upgradePluginAPI(plugin);
        plugins.push(plugin);
      }
      function fire(event, args) {
        const cb = event;
        plugins.forEach(function(plugin) {
          if (plugin[cb]) {
            plugin[cb](args);
          }
        });
      }
      function deprecateFixMarkup(arg) {
        deprecated("10.2.0", "fixMarkup will be removed entirely in v11.0");
        deprecated("10.2.0", "Please see https://github.com/highlightjs/highlight.js/issues/2534");
        return fixMarkup(arg);
      }
      function deprecateHighlightBlock(el) {
        deprecated("10.7.0", "highlightBlock will be removed entirely in v12.0");
        deprecated("10.7.0", "Please use highlightElement now.");
        return highlightElement(el);
      }
      Object.assign(hljs2, {
        highlight: highlight3,
        highlightAuto,
        highlightAll,
        fixMarkup: deprecateFixMarkup,
        highlightElement,
        // TODO: Remove with v12 API
        highlightBlock: deprecateHighlightBlock,
        configure,
        initHighlighting,
        initHighlightingOnLoad,
        registerLanguage,
        unregisterLanguage,
        listLanguages,
        getLanguage,
        registerAliases,
        requireLanguage,
        autoDetection,
        inherit: inherit$1,
        addPlugin,
        // plugins for frameworks
        vuePlugin: BuildVuePlugin(hljs2).VuePlugin
      });
      hljs2.debugMode = function() {
        SAFE_MODE = false;
      };
      hljs2.safeMode = function() {
        SAFE_MODE = true;
      };
      hljs2.versionString = version;
      for (const key in MODES) {
        if (typeof MODES[key] === "object") {
          deepFreezeEs6(MODES[key]);
        }
      }
      Object.assign(hljs2, MODES);
      hljs2.addPlugin(brPlugin);
      hljs2.addPlugin(mergeHTMLPlugin);
      hljs2.addPlugin(tabReplacePlugin);
      return hljs2;
    };
    var highlight2 = HLJS({});
    module.exports = highlight2;
  }
});

// node_modules/highlight.js/lib/languages/bash.js
var require_bash = __commonJS({
  "node_modules/highlight.js/lib/languages/bash.js"(exports, module) {
    function source(re) {
      if (!re) return null;
      if (typeof re === "string") return re;
      return re.source;
    }
    function concat(...args) {
      const joined = args.map((x) => source(x)).join("");
      return joined;
    }
    function bash2(hljs2) {
      const VAR = {};
      const BRACED_VAR = {
        begin: /\$\{/,
        end: /\}/,
        contains: [
          "self",
          {
            begin: /:-/,
            contains: [VAR]
          }
          // default values
        ]
      };
      Object.assign(VAR, {
        className: "variable",
        variants: [
          { begin: concat(
            /\$[\w\d#@][\w\d_]*/,
            // negative look-ahead tries to avoid matching patterns that are not
            // Perl at all like $ident$, @ident@, etc.
            `(?![\\w\\d])(?![$])`
          ) },
          BRACED_VAR
        ]
      });
      const SUBST = {
        className: "subst",
        begin: /\$\(/,
        end: /\)/,
        contains: [hljs2.BACKSLASH_ESCAPE]
      };
      const HERE_DOC = {
        begin: /<<-?\s*(?=\w+)/,
        starts: {
          contains: [
            hljs2.END_SAME_AS_BEGIN({
              begin: /(\w+)/,
              end: /(\w+)/,
              className: "string"
            })
          ]
        }
      };
      const QUOTE_STRING = {
        className: "string",
        begin: /"/,
        end: /"/,
        contains: [
          hljs2.BACKSLASH_ESCAPE,
          VAR,
          SUBST
        ]
      };
      SUBST.contains.push(QUOTE_STRING);
      const ESCAPED_QUOTE = {
        className: "",
        begin: /\\"/
      };
      const APOS_STRING = {
        className: "string",
        begin: /'/,
        end: /'/
      };
      const ARITHMETIC = {
        begin: /\$\(\(/,
        end: /\)\)/,
        contains: [
          { begin: /\d+#[0-9a-f]+/, className: "number" },
          hljs2.NUMBER_MODE,
          VAR
        ]
      };
      const SH_LIKE_SHELLS = [
        "fish",
        "bash",
        "zsh",
        "sh",
        "csh",
        "ksh",
        "tcsh",
        "dash",
        "scsh"
      ];
      const KNOWN_SHEBANG = hljs2.SHEBANG({
        binary: `(${SH_LIKE_SHELLS.join("|")})`,
        relevance: 10
      });
      const FUNCTION = {
        className: "function",
        begin: /\w[\w\d_]*\s*\(\s*\)\s*\{/,
        returnBegin: true,
        contains: [hljs2.inherit(hljs2.TITLE_MODE, { begin: /\w[\w\d_]*/ })],
        relevance: 0
      };
      return {
        name: "Bash",
        aliases: ["sh", "zsh"],
        keywords: {
          $pattern: /\b[a-z._-]+\b/,
          keyword: "if then else elif fi for while in do done case esac function",
          literal: "true false",
          built_in: (
            // Shell built-ins
            // http://www.gnu.org/software/bash/manual/html_node/Shell-Builtin-Commands.html
            "break cd continue eval exec exit export getopts hash pwd readonly return shift test times trap umask unset alias bind builtin caller command declare echo enable help let local logout mapfile printf read readarray source type typeset ulimit unalias set shopt autoload bg bindkey bye cap chdir clone comparguments compcall compctl compdescribe compfiles compgroups compquote comptags comptry compvalues dirs disable disown echotc echoti emulate fc fg float functions getcap getln history integer jobs kill limit log noglob popd print pushd pushln rehash sched setcap setopt stat suspend ttyctl unfunction unhash unlimit unsetopt vared wait whence where which zcompile zformat zftp zle zmodload zparseopts zprof zpty zregexparse zsocket zstyle ztcp"
          )
        },
        contains: [
          KNOWN_SHEBANG,
          // to catch known shells and boost relevancy
          hljs2.SHEBANG(),
          // to catch unknown shells but still highlight the shebang
          FUNCTION,
          ARITHMETIC,
          hljs2.HASH_COMMENT_MODE,
          HERE_DOC,
          QUOTE_STRING,
          ESCAPED_QUOTE,
          APOS_STRING,
          VAR
        ]
      };
    }
    module.exports = bash2;
  }
});

// node_modules/highlight.js/lib/languages/c.js
var require_c = __commonJS({
  "node_modules/highlight.js/lib/languages/c.js"(exports, module) {
    function source(re) {
      if (!re) return null;
      if (typeof re === "string") return re;
      return re.source;
    }
    function optional(re) {
      return concat("(", re, ")?");
    }
    function concat(...args) {
      const joined = args.map((x) => source(x)).join("");
      return joined;
    }
    function c2(hljs2) {
      const C_LINE_COMMENT_MODE = hljs2.COMMENT("//", "$", {
        contains: [
          {
            begin: /\\\n/
          }
        ]
      });
      const DECLTYPE_AUTO_RE = "decltype\\(auto\\)";
      const NAMESPACE_RE = "[a-zA-Z_]\\w*::";
      const TEMPLATE_ARGUMENT_RE = "<[^<>]+>";
      const FUNCTION_TYPE_RE = "(" + DECLTYPE_AUTO_RE + "|" + optional(NAMESPACE_RE) + "[a-zA-Z_]\\w*" + optional(TEMPLATE_ARGUMENT_RE) + ")";
      const CPP_PRIMITIVE_TYPES = {
        className: "keyword",
        begin: "\\b[a-z\\d_]*_t\\b"
      };
      const CHARACTER_ESCAPES = "\\\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4,8}|[0-7]{3}|\\S)";
      const STRINGS = {
        className: "string",
        variants: [
          {
            begin: '(u8?|U|L)?"',
            end: '"',
            illegal: "\\n",
            contains: [hljs2.BACKSLASH_ESCAPE]
          },
          {
            begin: "(u8?|U|L)?'(" + CHARACTER_ESCAPES + "|.)",
            end: "'",
            illegal: "."
          },
          hljs2.END_SAME_AS_BEGIN({
            begin: /(?:u8?|U|L)?R"([^()\\ ]{0,16})\(/,
            end: /\)([^()\\ ]{0,16})"/
          })
        ]
      };
      const NUMBERS = {
        className: "number",
        variants: [
          {
            begin: "\\b(0b[01']+)"
          },
          {
            begin: "(-?)\\b([\\d']+(\\.[\\d']*)?|\\.[\\d']+)((ll|LL|l|L)(u|U)?|(u|U)(ll|LL|l|L)?|f|F|b|B)"
          },
          {
            begin: "(-?)(\\b0[xX][a-fA-F0-9']+|(\\b[\\d']+(\\.[\\d']*)?|\\.[\\d']+)([eE][-+]?[\\d']+)?)"
          }
        ],
        relevance: 0
      };
      const PREPROCESSOR = {
        className: "meta",
        begin: /#\s*[a-z]+\b/,
        end: /$/,
        keywords: {
          "meta-keyword": "if else elif endif define undef warning error line pragma _Pragma ifdef ifndef include"
        },
        contains: [
          {
            begin: /\\\n/,
            relevance: 0
          },
          hljs2.inherit(STRINGS, {
            className: "meta-string"
          }),
          {
            className: "meta-string",
            begin: /<.*?>/
          },
          C_LINE_COMMENT_MODE,
          hljs2.C_BLOCK_COMMENT_MODE
        ]
      };
      const TITLE_MODE = {
        className: "title",
        begin: optional(NAMESPACE_RE) + hljs2.IDENT_RE,
        relevance: 0
      };
      const FUNCTION_TITLE = optional(NAMESPACE_RE) + hljs2.IDENT_RE + "\\s*\\(";
      const CPP_KEYWORDS = {
        keyword: "int float while private char char8_t char16_t char32_t catch import module export virtual operator sizeof dynamic_cast|10 typedef const_cast|10 const for static_cast|10 union namespace unsigned long volatile static protected bool template mutable if public friend do goto auto void enum else break extern using asm case typeid wchar_t short reinterpret_cast|10 default double register explicit signed typename try this switch continue inline delete alignas alignof constexpr consteval constinit decltype concept co_await co_return co_yield requires noexcept static_assert thread_local restrict final override atomic_bool atomic_char atomic_schar atomic_uchar atomic_short atomic_ushort atomic_int atomic_uint atomic_long atomic_ulong atomic_llong atomic_ullong new throw return and and_eq bitand bitor compl not not_eq or or_eq xor xor_eq",
        built_in: "std string wstring cin cout cerr clog stdin stdout stderr stringstream istringstream ostringstream auto_ptr deque list queue stack vector map set pair bitset multiset multimap unordered_set unordered_map unordered_multiset unordered_multimap priority_queue make_pair array shared_ptr abort terminate abs acos asin atan2 atan calloc ceil cosh cos exit exp fabs floor fmod fprintf fputs free frexp fscanf future isalnum isalpha iscntrl isdigit isgraph islower isprint ispunct isspace isupper isxdigit tolower toupper labs ldexp log10 log malloc realloc memchr memcmp memcpy memset modf pow printf putchar puts scanf sinh sin snprintf sprintf sqrt sscanf strcat strchr strcmp strcpy strcspn strlen strncat strncmp strncpy strpbrk strrchr strspn strstr tanh tan vfprintf vprintf vsprintf endl initializer_list unique_ptr _Bool complex _Complex imaginary _Imaginary",
        literal: "true false nullptr NULL"
      };
      const EXPRESSION_CONTAINS = [
        PREPROCESSOR,
        CPP_PRIMITIVE_TYPES,
        C_LINE_COMMENT_MODE,
        hljs2.C_BLOCK_COMMENT_MODE,
        NUMBERS,
        STRINGS
      ];
      const EXPRESSION_CONTEXT = {
        // This mode covers expression context where we can't expect a function
        // definition and shouldn't highlight anything that looks like one:
        // `return some()`, `else if()`, `(x*sum(1, 2))`
        variants: [
          {
            begin: /=/,
            end: /;/
          },
          {
            begin: /\(/,
            end: /\)/
          },
          {
            beginKeywords: "new throw return else",
            end: /;/
          }
        ],
        keywords: CPP_KEYWORDS,
        contains: EXPRESSION_CONTAINS.concat([
          {
            begin: /\(/,
            end: /\)/,
            keywords: CPP_KEYWORDS,
            contains: EXPRESSION_CONTAINS.concat(["self"]),
            relevance: 0
          }
        ]),
        relevance: 0
      };
      const FUNCTION_DECLARATION = {
        className: "function",
        begin: "(" + FUNCTION_TYPE_RE + "[\\*&\\s]+)+" + FUNCTION_TITLE,
        returnBegin: true,
        end: /[{;=]/,
        excludeEnd: true,
        keywords: CPP_KEYWORDS,
        illegal: /[^\w\s\*&:<>.]/,
        contains: [
          {
            // to prevent it from being confused as the function title
            begin: DECLTYPE_AUTO_RE,
            keywords: CPP_KEYWORDS,
            relevance: 0
          },
          {
            begin: FUNCTION_TITLE,
            returnBegin: true,
            contains: [TITLE_MODE],
            relevance: 0
          },
          {
            className: "params",
            begin: /\(/,
            end: /\)/,
            keywords: CPP_KEYWORDS,
            relevance: 0,
            contains: [
              C_LINE_COMMENT_MODE,
              hljs2.C_BLOCK_COMMENT_MODE,
              STRINGS,
              NUMBERS,
              CPP_PRIMITIVE_TYPES,
              // Count matching parentheses.
              {
                begin: /\(/,
                end: /\)/,
                keywords: CPP_KEYWORDS,
                relevance: 0,
                contains: [
                  "self",
                  C_LINE_COMMENT_MODE,
                  hljs2.C_BLOCK_COMMENT_MODE,
                  STRINGS,
                  NUMBERS,
                  CPP_PRIMITIVE_TYPES
                ]
              }
            ]
          },
          CPP_PRIMITIVE_TYPES,
          C_LINE_COMMENT_MODE,
          hljs2.C_BLOCK_COMMENT_MODE,
          PREPROCESSOR
        ]
      };
      return {
        name: "C",
        aliases: [
          "h"
        ],
        keywords: CPP_KEYWORDS,
        // Until differentiations are added between `c` and `cpp`, `c` will
        // not be auto-detected to avoid auto-detect conflicts between C and C++
        disableAutodetect: true,
        illegal: "</",
        contains: [].concat(
          EXPRESSION_CONTEXT,
          FUNCTION_DECLARATION,
          EXPRESSION_CONTAINS,
          [
            PREPROCESSOR,
            {
              // containers: ie, `vector <int> rooms (9);`
              begin: "\\b(deque|list|queue|priority_queue|pair|stack|vector|map|set|bitset|multiset|multimap|unordered_map|unordered_set|unordered_multiset|unordered_multimap|array)\\s*<",
              end: ">",
              keywords: CPP_KEYWORDS,
              contains: [
                "self",
                CPP_PRIMITIVE_TYPES
              ]
            },
            {
              begin: hljs2.IDENT_RE + "::",
              keywords: CPP_KEYWORDS
            },
            {
              className: "class",
              beginKeywords: "enum class struct union",
              end: /[{;:<>=]/,
              contains: [
                {
                  beginKeywords: "final class struct"
                },
                hljs2.TITLE_MODE
              ]
            }
          ]
        ),
        exports: {
          preprocessor: PREPROCESSOR,
          strings: STRINGS,
          keywords: CPP_KEYWORDS
        }
      };
    }
    module.exports = c2;
  }
});

// node_modules/highlight.js/lib/languages/cpp.js
var require_cpp = __commonJS({
  "node_modules/highlight.js/lib/languages/cpp.js"(exports, module) {
    function source(re) {
      if (!re) return null;
      if (typeof re === "string") return re;
      return re.source;
    }
    function lookahead(re) {
      return concat("(?=", re, ")");
    }
    function optional(re) {
      return concat("(", re, ")?");
    }
    function concat(...args) {
      const joined = args.map((x) => source(x)).join("");
      return joined;
    }
    function cpp2(hljs2) {
      const C_LINE_COMMENT_MODE = hljs2.COMMENT("//", "$", {
        contains: [
          {
            begin: /\\\n/
          }
        ]
      });
      const DECLTYPE_AUTO_RE = "decltype\\(auto\\)";
      const NAMESPACE_RE = "[a-zA-Z_]\\w*::";
      const TEMPLATE_ARGUMENT_RE = "<[^<>]+>";
      const FUNCTION_TYPE_RE = "(" + DECLTYPE_AUTO_RE + "|" + optional(NAMESPACE_RE) + "[a-zA-Z_]\\w*" + optional(TEMPLATE_ARGUMENT_RE) + ")";
      const CPP_PRIMITIVE_TYPES = {
        className: "keyword",
        begin: "\\b[a-z\\d_]*_t\\b"
      };
      const CHARACTER_ESCAPES = "\\\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4,8}|[0-7]{3}|\\S)";
      const STRINGS = {
        className: "string",
        variants: [
          {
            begin: '(u8?|U|L)?"',
            end: '"',
            illegal: "\\n",
            contains: [hljs2.BACKSLASH_ESCAPE]
          },
          {
            begin: "(u8?|U|L)?'(" + CHARACTER_ESCAPES + "|.)",
            end: "'",
            illegal: "."
          },
          hljs2.END_SAME_AS_BEGIN({
            begin: /(?:u8?|U|L)?R"([^()\\ ]{0,16})\(/,
            end: /\)([^()\\ ]{0,16})"/
          })
        ]
      };
      const NUMBERS = {
        className: "number",
        variants: [
          {
            begin: "\\b(0b[01']+)"
          },
          {
            begin: "(-?)\\b([\\d']+(\\.[\\d']*)?|\\.[\\d']+)((ll|LL|l|L)(u|U)?|(u|U)(ll|LL|l|L)?|f|F|b|B)"
          },
          {
            begin: "(-?)(\\b0[xX][a-fA-F0-9']+|(\\b[\\d']+(\\.[\\d']*)?|\\.[\\d']+)([eE][-+]?[\\d']+)?)"
          }
        ],
        relevance: 0
      };
      const PREPROCESSOR = {
        className: "meta",
        begin: /#\s*[a-z]+\b/,
        end: /$/,
        keywords: {
          "meta-keyword": "if else elif endif define undef warning error line pragma _Pragma ifdef ifndef include"
        },
        contains: [
          {
            begin: /\\\n/,
            relevance: 0
          },
          hljs2.inherit(STRINGS, {
            className: "meta-string"
          }),
          {
            className: "meta-string",
            begin: /<.*?>/
          },
          C_LINE_COMMENT_MODE,
          hljs2.C_BLOCK_COMMENT_MODE
        ]
      };
      const TITLE_MODE = {
        className: "title",
        begin: optional(NAMESPACE_RE) + hljs2.IDENT_RE,
        relevance: 0
      };
      const FUNCTION_TITLE = optional(NAMESPACE_RE) + hljs2.IDENT_RE + "\\s*\\(";
      const COMMON_CPP_HINTS = [
        "asin",
        "atan2",
        "atan",
        "calloc",
        "ceil",
        "cosh",
        "cos",
        "exit",
        "exp",
        "fabs",
        "floor",
        "fmod",
        "fprintf",
        "fputs",
        "free",
        "frexp",
        "auto_ptr",
        "deque",
        "list",
        "queue",
        "stack",
        "vector",
        "map",
        "set",
        "pair",
        "bitset",
        "multiset",
        "multimap",
        "unordered_set",
        "fscanf",
        "future",
        "isalnum",
        "isalpha",
        "iscntrl",
        "isdigit",
        "isgraph",
        "islower",
        "isprint",
        "ispunct",
        "isspace",
        "isupper",
        "isxdigit",
        "tolower",
        "toupper",
        "labs",
        "ldexp",
        "log10",
        "log",
        "malloc",
        "realloc",
        "memchr",
        "memcmp",
        "memcpy",
        "memset",
        "modf",
        "pow",
        "printf",
        "putchar",
        "puts",
        "scanf",
        "sinh",
        "sin",
        "snprintf",
        "sprintf",
        "sqrt",
        "sscanf",
        "strcat",
        "strchr",
        "strcmp",
        "strcpy",
        "strcspn",
        "strlen",
        "strncat",
        "strncmp",
        "strncpy",
        "strpbrk",
        "strrchr",
        "strspn",
        "strstr",
        "tanh",
        "tan",
        "unordered_map",
        "unordered_multiset",
        "unordered_multimap",
        "priority_queue",
        "make_pair",
        "array",
        "shared_ptr",
        "abort",
        "terminate",
        "abs",
        "acos",
        "vfprintf",
        "vprintf",
        "vsprintf",
        "endl",
        "initializer_list",
        "unique_ptr",
        "complex",
        "imaginary",
        "std",
        "string",
        "wstring",
        "cin",
        "cout",
        "cerr",
        "clog",
        "stdin",
        "stdout",
        "stderr",
        "stringstream",
        "istringstream",
        "ostringstream"
      ];
      const CPP_KEYWORDS = {
        keyword: "int float while private char char8_t char16_t char32_t catch import module export virtual operator sizeof dynamic_cast|10 typedef const_cast|10 const for static_cast|10 union namespace unsigned long volatile static protected bool template mutable if public friend do goto auto void enum else break extern using asm case typeid wchar_t short reinterpret_cast|10 default double register explicit signed typename try this switch continue inline delete alignas alignof constexpr consteval constinit decltype concept co_await co_return co_yield requires noexcept static_assert thread_local restrict final override atomic_bool atomic_char atomic_schar atomic_uchar atomic_short atomic_ushort atomic_int atomic_uint atomic_long atomic_ulong atomic_llong atomic_ullong new throw return and and_eq bitand bitor compl not not_eq or or_eq xor xor_eq",
        built_in: "_Bool _Complex _Imaginary",
        _relevance_hints: COMMON_CPP_HINTS,
        literal: "true false nullptr NULL"
      };
      const FUNCTION_DISPATCH = {
        className: "function.dispatch",
        relevance: 0,
        keywords: CPP_KEYWORDS,
        begin: concat(
          /\b/,
          /(?!decltype)/,
          /(?!if)/,
          /(?!for)/,
          /(?!while)/,
          hljs2.IDENT_RE,
          lookahead(/\s*\(/)
        )
      };
      const EXPRESSION_CONTAINS = [
        FUNCTION_DISPATCH,
        PREPROCESSOR,
        CPP_PRIMITIVE_TYPES,
        C_LINE_COMMENT_MODE,
        hljs2.C_BLOCK_COMMENT_MODE,
        NUMBERS,
        STRINGS
      ];
      const EXPRESSION_CONTEXT = {
        // This mode covers expression context where we can't expect a function
        // definition and shouldn't highlight anything that looks like one:
        // `return some()`, `else if()`, `(x*sum(1, 2))`
        variants: [
          {
            begin: /=/,
            end: /;/
          },
          {
            begin: /\(/,
            end: /\)/
          },
          {
            beginKeywords: "new throw return else",
            end: /;/
          }
        ],
        keywords: CPP_KEYWORDS,
        contains: EXPRESSION_CONTAINS.concat([
          {
            begin: /\(/,
            end: /\)/,
            keywords: CPP_KEYWORDS,
            contains: EXPRESSION_CONTAINS.concat(["self"]),
            relevance: 0
          }
        ]),
        relevance: 0
      };
      const FUNCTION_DECLARATION = {
        className: "function",
        begin: "(" + FUNCTION_TYPE_RE + "[\\*&\\s]+)+" + FUNCTION_TITLE,
        returnBegin: true,
        end: /[{;=]/,
        excludeEnd: true,
        keywords: CPP_KEYWORDS,
        illegal: /[^\w\s\*&:<>.]/,
        contains: [
          {
            // to prevent it from being confused as the function title
            begin: DECLTYPE_AUTO_RE,
            keywords: CPP_KEYWORDS,
            relevance: 0
          },
          {
            begin: FUNCTION_TITLE,
            returnBegin: true,
            contains: [TITLE_MODE],
            relevance: 0
          },
          // needed because we do not have look-behind on the below rule
          // to prevent it from grabbing the final : in a :: pair
          {
            begin: /::/,
            relevance: 0
          },
          // initializers
          {
            begin: /:/,
            endsWithParent: true,
            contains: [
              STRINGS,
              NUMBERS
            ]
          },
          {
            className: "params",
            begin: /\(/,
            end: /\)/,
            keywords: CPP_KEYWORDS,
            relevance: 0,
            contains: [
              C_LINE_COMMENT_MODE,
              hljs2.C_BLOCK_COMMENT_MODE,
              STRINGS,
              NUMBERS,
              CPP_PRIMITIVE_TYPES,
              // Count matching parentheses.
              {
                begin: /\(/,
                end: /\)/,
                keywords: CPP_KEYWORDS,
                relevance: 0,
                contains: [
                  "self",
                  C_LINE_COMMENT_MODE,
                  hljs2.C_BLOCK_COMMENT_MODE,
                  STRINGS,
                  NUMBERS,
                  CPP_PRIMITIVE_TYPES
                ]
              }
            ]
          },
          CPP_PRIMITIVE_TYPES,
          C_LINE_COMMENT_MODE,
          hljs2.C_BLOCK_COMMENT_MODE,
          PREPROCESSOR
        ]
      };
      return {
        name: "C++",
        aliases: [
          "cc",
          "c++",
          "h++",
          "hpp",
          "hh",
          "hxx",
          "cxx"
        ],
        keywords: CPP_KEYWORDS,
        illegal: "</",
        classNameAliases: {
          "function.dispatch": "built_in"
        },
        contains: [].concat(
          EXPRESSION_CONTEXT,
          FUNCTION_DECLARATION,
          FUNCTION_DISPATCH,
          EXPRESSION_CONTAINS,
          [
            PREPROCESSOR,
            {
              // containers: ie, `vector <int> rooms (9);`
              begin: "\\b(deque|list|queue|priority_queue|pair|stack|vector|map|set|bitset|multiset|multimap|unordered_map|unordered_set|unordered_multiset|unordered_multimap|array)\\s*<",
              end: ">",
              keywords: CPP_KEYWORDS,
              contains: [
                "self",
                CPP_PRIMITIVE_TYPES
              ]
            },
            {
              begin: hljs2.IDENT_RE + "::",
              keywords: CPP_KEYWORDS
            },
            {
              className: "class",
              beginKeywords: "enum class struct union",
              end: /[{;:<>=]/,
              contains: [
                {
                  beginKeywords: "final class struct"
                },
                hljs2.TITLE_MODE
              ]
            }
          ]
        ),
        exports: {
          preprocessor: PREPROCESSOR,
          strings: STRINGS,
          keywords: CPP_KEYWORDS
        }
      };
    }
    module.exports = cpp2;
  }
});

// node_modules/highlight.js/lib/languages/csharp.js
var require_csharp = __commonJS({
  "node_modules/highlight.js/lib/languages/csharp.js"(exports, module) {
    function csharp2(hljs2) {
      const BUILT_IN_KEYWORDS = [
        "bool",
        "byte",
        "char",
        "decimal",
        "delegate",
        "double",
        "dynamic",
        "enum",
        "float",
        "int",
        "long",
        "nint",
        "nuint",
        "object",
        "sbyte",
        "short",
        "string",
        "ulong",
        "uint",
        "ushort"
      ];
      const FUNCTION_MODIFIERS = [
        "public",
        "private",
        "protected",
        "static",
        "internal",
        "protected",
        "abstract",
        "async",
        "extern",
        "override",
        "unsafe",
        "virtual",
        "new",
        "sealed",
        "partial"
      ];
      const LITERAL_KEYWORDS = [
        "default",
        "false",
        "null",
        "true"
      ];
      const NORMAL_KEYWORDS = [
        "abstract",
        "as",
        "base",
        "break",
        "case",
        "class",
        "const",
        "continue",
        "do",
        "else",
        "event",
        "explicit",
        "extern",
        "finally",
        "fixed",
        "for",
        "foreach",
        "goto",
        "if",
        "implicit",
        "in",
        "interface",
        "internal",
        "is",
        "lock",
        "namespace",
        "new",
        "operator",
        "out",
        "override",
        "params",
        "private",
        "protected",
        "public",
        "readonly",
        "record",
        "ref",
        "return",
        "sealed",
        "sizeof",
        "stackalloc",
        "static",
        "struct",
        "switch",
        "this",
        "throw",
        "try",
        "typeof",
        "unchecked",
        "unsafe",
        "using",
        "virtual",
        "void",
        "volatile",
        "while"
      ];
      const CONTEXTUAL_KEYWORDS = [
        "add",
        "alias",
        "and",
        "ascending",
        "async",
        "await",
        "by",
        "descending",
        "equals",
        "from",
        "get",
        "global",
        "group",
        "init",
        "into",
        "join",
        "let",
        "nameof",
        "not",
        "notnull",
        "on",
        "or",
        "orderby",
        "partial",
        "remove",
        "select",
        "set",
        "unmanaged",
        "value|0",
        "var",
        "when",
        "where",
        "with",
        "yield"
      ];
      const KEYWORDS = {
        keyword: NORMAL_KEYWORDS.concat(CONTEXTUAL_KEYWORDS),
        built_in: BUILT_IN_KEYWORDS,
        literal: LITERAL_KEYWORDS
      };
      const TITLE_MODE = hljs2.inherit(hljs2.TITLE_MODE, {
        begin: "[a-zA-Z](\\.?\\w)*"
      });
      const NUMBERS = {
        className: "number",
        variants: [
          {
            begin: "\\b(0b[01']+)"
          },
          {
            begin: "(-?)\\b([\\d']+(\\.[\\d']*)?|\\.[\\d']+)(u|U|l|L|ul|UL|f|F|b|B)"
          },
          {
            begin: "(-?)(\\b0[xX][a-fA-F0-9']+|(\\b[\\d']+(\\.[\\d']*)?|\\.[\\d']+)([eE][-+]?[\\d']+)?)"
          }
        ],
        relevance: 0
      };
      const VERBATIM_STRING = {
        className: "string",
        begin: '@"',
        end: '"',
        contains: [
          {
            begin: '""'
          }
        ]
      };
      const VERBATIM_STRING_NO_LF = hljs2.inherit(VERBATIM_STRING, {
        illegal: /\n/
      });
      const SUBST = {
        className: "subst",
        begin: /\{/,
        end: /\}/,
        keywords: KEYWORDS
      };
      const SUBST_NO_LF = hljs2.inherit(SUBST, {
        illegal: /\n/
      });
      const INTERPOLATED_STRING = {
        className: "string",
        begin: /\$"/,
        end: '"',
        illegal: /\n/,
        contains: [
          {
            begin: /\{\{/
          },
          {
            begin: /\}\}/
          },
          hljs2.BACKSLASH_ESCAPE,
          SUBST_NO_LF
        ]
      };
      const INTERPOLATED_VERBATIM_STRING = {
        className: "string",
        begin: /\$@"/,
        end: '"',
        contains: [
          {
            begin: /\{\{/
          },
          {
            begin: /\}\}/
          },
          {
            begin: '""'
          },
          SUBST
        ]
      };
      const INTERPOLATED_VERBATIM_STRING_NO_LF = hljs2.inherit(INTERPOLATED_VERBATIM_STRING, {
        illegal: /\n/,
        contains: [
          {
            begin: /\{\{/
          },
          {
            begin: /\}\}/
          },
          {
            begin: '""'
          },
          SUBST_NO_LF
        ]
      });
      SUBST.contains = [
        INTERPOLATED_VERBATIM_STRING,
        INTERPOLATED_STRING,
        VERBATIM_STRING,
        hljs2.APOS_STRING_MODE,
        hljs2.QUOTE_STRING_MODE,
        NUMBERS,
        hljs2.C_BLOCK_COMMENT_MODE
      ];
      SUBST_NO_LF.contains = [
        INTERPOLATED_VERBATIM_STRING_NO_LF,
        INTERPOLATED_STRING,
        VERBATIM_STRING_NO_LF,
        hljs2.APOS_STRING_MODE,
        hljs2.QUOTE_STRING_MODE,
        NUMBERS,
        hljs2.inherit(hljs2.C_BLOCK_COMMENT_MODE, {
          illegal: /\n/
        })
      ];
      const STRING = {
        variants: [
          INTERPOLATED_VERBATIM_STRING,
          INTERPOLATED_STRING,
          VERBATIM_STRING,
          hljs2.APOS_STRING_MODE,
          hljs2.QUOTE_STRING_MODE
        ]
      };
      const GENERIC_MODIFIER = {
        begin: "<",
        end: ">",
        contains: [
          {
            beginKeywords: "in out"
          },
          TITLE_MODE
        ]
      };
      const TYPE_IDENT_RE = hljs2.IDENT_RE + "(<" + hljs2.IDENT_RE + "(\\s*,\\s*" + hljs2.IDENT_RE + ")*>)?(\\[\\])?";
      const AT_IDENTIFIER = {
        // prevents expressions like `@class` from incorrect flagging
        // `class` as a keyword
        begin: "@" + hljs2.IDENT_RE,
        relevance: 0
      };
      return {
        name: "C#",
        aliases: [
          "cs",
          "c#"
        ],
        keywords: KEYWORDS,
        illegal: /::/,
        contains: [
          hljs2.COMMENT(
            "///",
            "$",
            {
              returnBegin: true,
              contains: [
                {
                  className: "doctag",
                  variants: [
                    {
                      begin: "///",
                      relevance: 0
                    },
                    {
                      begin: "<!--|-->"
                    },
                    {
                      begin: "</?",
                      end: ">"
                    }
                  ]
                }
              ]
            }
          ),
          hljs2.C_LINE_COMMENT_MODE,
          hljs2.C_BLOCK_COMMENT_MODE,
          {
            className: "meta",
            begin: "#",
            end: "$",
            keywords: {
              "meta-keyword": "if else elif endif define undef warning error line region endregion pragma checksum"
            }
          },
          STRING,
          NUMBERS,
          {
            beginKeywords: "class interface",
            relevance: 0,
            end: /[{;=]/,
            illegal: /[^\s:,]/,
            contains: [
              {
                beginKeywords: "where class"
              },
              TITLE_MODE,
              GENERIC_MODIFIER,
              hljs2.C_LINE_COMMENT_MODE,
              hljs2.C_BLOCK_COMMENT_MODE
            ]
          },
          {
            beginKeywords: "namespace",
            relevance: 0,
            end: /[{;=]/,
            illegal: /[^\s:]/,
            contains: [
              TITLE_MODE,
              hljs2.C_LINE_COMMENT_MODE,
              hljs2.C_BLOCK_COMMENT_MODE
            ]
          },
          {
            beginKeywords: "record",
            relevance: 0,
            end: /[{;=]/,
            illegal: /[^\s:]/,
            contains: [
              TITLE_MODE,
              GENERIC_MODIFIER,
              hljs2.C_LINE_COMMENT_MODE,
              hljs2.C_BLOCK_COMMENT_MODE
            ]
          },
          {
            // [Attributes("")]
            className: "meta",
            begin: "^\\s*\\[",
            excludeBegin: true,
            end: "\\]",
            excludeEnd: true,
            contains: [
              {
                className: "meta-string",
                begin: /"/,
                end: /"/
              }
            ]
          },
          {
            // Expression keywords prevent 'keyword Name(...)' from being
            // recognized as a function definition
            beginKeywords: "new return throw await else",
            relevance: 0
          },
          {
            className: "function",
            begin: "(" + TYPE_IDENT_RE + "\\s+)+" + hljs2.IDENT_RE + "\\s*(<.+>\\s*)?\\(",
            returnBegin: true,
            end: /\s*[{;=]/,
            excludeEnd: true,
            keywords: KEYWORDS,
            contains: [
              // prevents these from being highlighted `title`
              {
                beginKeywords: FUNCTION_MODIFIERS.join(" "),
                relevance: 0
              },
              {
                begin: hljs2.IDENT_RE + "\\s*(<.+>\\s*)?\\(",
                returnBegin: true,
                contains: [
                  hljs2.TITLE_MODE,
                  GENERIC_MODIFIER
                ],
                relevance: 0
              },
              {
                className: "params",
                begin: /\(/,
                end: /\)/,
                excludeBegin: true,
                excludeEnd: true,
                keywords: KEYWORDS,
                relevance: 0,
                contains: [
                  STRING,
                  NUMBERS,
                  hljs2.C_BLOCK_COMMENT_MODE
                ]
              },
              hljs2.C_LINE_COMMENT_MODE,
              hljs2.C_BLOCK_COMMENT_MODE
            ]
          },
          AT_IDENTIFIER
        ]
      };
    }
    module.exports = csharp2;
  }
});

// node_modules/highlight.js/lib/languages/dart.js
var require_dart = __commonJS({
  "node_modules/highlight.js/lib/languages/dart.js"(exports, module) {
    function dart2(hljs2) {
      const SUBST = {
        className: "subst",
        variants: [{
          begin: "\\$[A-Za-z0-9_]+"
        }]
      };
      const BRACED_SUBST = {
        className: "subst",
        variants: [{
          begin: /\$\{/,
          end: /\}/
        }],
        keywords: "true false null this is new super"
      };
      const STRING = {
        className: "string",
        variants: [
          {
            begin: "r'''",
            end: "'''"
          },
          {
            begin: 'r"""',
            end: '"""'
          },
          {
            begin: "r'",
            end: "'",
            illegal: "\\n"
          },
          {
            begin: 'r"',
            end: '"',
            illegal: "\\n"
          },
          {
            begin: "'''",
            end: "'''",
            contains: [
              hljs2.BACKSLASH_ESCAPE,
              SUBST,
              BRACED_SUBST
            ]
          },
          {
            begin: '"""',
            end: '"""',
            contains: [
              hljs2.BACKSLASH_ESCAPE,
              SUBST,
              BRACED_SUBST
            ]
          },
          {
            begin: "'",
            end: "'",
            illegal: "\\n",
            contains: [
              hljs2.BACKSLASH_ESCAPE,
              SUBST,
              BRACED_SUBST
            ]
          },
          {
            begin: '"',
            end: '"',
            illegal: "\\n",
            contains: [
              hljs2.BACKSLASH_ESCAPE,
              SUBST,
              BRACED_SUBST
            ]
          }
        ]
      };
      BRACED_SUBST.contains = [
        hljs2.C_NUMBER_MODE,
        STRING
      ];
      const BUILT_IN_TYPES = [
        // dart:core
        "Comparable",
        "DateTime",
        "Duration",
        "Function",
        "Iterable",
        "Iterator",
        "List",
        "Map",
        "Match",
        "Object",
        "Pattern",
        "RegExp",
        "Set",
        "Stopwatch",
        "String",
        "StringBuffer",
        "StringSink",
        "Symbol",
        "Type",
        "Uri",
        "bool",
        "double",
        "int",
        "num",
        // dart:html
        "Element",
        "ElementList"
      ];
      const NULLABLE_BUILT_IN_TYPES = BUILT_IN_TYPES.map((e) => `${e}?`);
      const KEYWORDS = {
        keyword: "abstract as assert async await break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for Function get hide if implements import in inferface is late library mixin new null on operator part required rethrow return set show static super switch sync this throw true try typedef var void while with yield",
        built_in: BUILT_IN_TYPES.concat(NULLABLE_BUILT_IN_TYPES).concat([
          // dart:core
          "Never",
          "Null",
          "dynamic",
          "print",
          // dart:html
          "document",
          "querySelector",
          "querySelectorAll",
          "window"
        ]),
        $pattern: /[A-Za-z][A-Za-z0-9_]*\??/
      };
      return {
        name: "Dart",
        keywords: KEYWORDS,
        contains: [
          STRING,
          hljs2.COMMENT(
            /\/\*\*(?!\/)/,
            /\*\//,
            {
              subLanguage: "markdown",
              relevance: 0
            }
          ),
          hljs2.COMMENT(
            /\/{3,} ?/,
            /$/,
            {
              contains: [{
                subLanguage: "markdown",
                begin: ".",
                end: "$",
                relevance: 0
              }]
            }
          ),
          hljs2.C_LINE_COMMENT_MODE,
          hljs2.C_BLOCK_COMMENT_MODE,
          {
            className: "class",
            beginKeywords: "class interface",
            end: /\{/,
            excludeEnd: true,
            contains: [
              {
                beginKeywords: "extends implements"
              },
              hljs2.UNDERSCORE_TITLE_MODE
            ]
          },
          hljs2.C_NUMBER_MODE,
          {
            className: "meta",
            begin: "@[A-Za-z]+"
          },
          {
            begin: "=>"
            // No markup, just a relevance booster
          }
        ]
      };
    }
    module.exports = dart2;
  }
});

// node_modules/highlight.js/lib/languages/go.js
var require_go = __commonJS({
  "node_modules/highlight.js/lib/languages/go.js"(exports, module) {
    function go2(hljs2) {
      const GO_KEYWORDS = {
        keyword: "break default func interface select case map struct chan else goto package switch const fallthrough if range type continue for import return var go defer bool byte complex64 complex128 float32 float64 int8 int16 int32 int64 string uint8 uint16 uint32 uint64 int uint uintptr rune",
        literal: "true false iota nil",
        built_in: "append cap close complex copy imag len make new panic print println real recover delete"
      };
      return {
        name: "Go",
        aliases: ["golang"],
        keywords: GO_KEYWORDS,
        illegal: "</",
        contains: [
          hljs2.C_LINE_COMMENT_MODE,
          hljs2.C_BLOCK_COMMENT_MODE,
          {
            className: "string",
            variants: [
              hljs2.QUOTE_STRING_MODE,
              hljs2.APOS_STRING_MODE,
              {
                begin: "`",
                end: "`"
              }
            ]
          },
          {
            className: "number",
            variants: [
              {
                begin: hljs2.C_NUMBER_RE + "[i]",
                relevance: 1
              },
              hljs2.C_NUMBER_MODE
            ]
          },
          {
            begin: /:=/
            // relevance booster
          },
          {
            className: "function",
            beginKeywords: "func",
            end: "\\s*(\\{|$)",
            excludeEnd: true,
            contains: [
              hljs2.TITLE_MODE,
              {
                className: "params",
                begin: /\(/,
                end: /\)/,
                keywords: GO_KEYWORDS,
                illegal: /["']/
              }
            ]
          }
        ]
      };
    }
    module.exports = go2;
  }
});

// node_modules/highlight.js/lib/languages/groovy.js
var require_groovy = __commonJS({
  "node_modules/highlight.js/lib/languages/groovy.js"(exports, module) {
    function source(re) {
      if (!re) return null;
      if (typeof re === "string") return re;
      return re.source;
    }
    function lookahead(re) {
      return concat("(?=", re, ")");
    }
    function concat(...args) {
      const joined = args.map((x) => source(x)).join("");
      return joined;
    }
    function variants(variants2, obj = {}) {
      obj.variants = variants2;
      return obj;
    }
    function groovy2(hljs2) {
      const IDENT_RE = "[A-Za-z0-9_$]+";
      const COMMENT = variants([
        hljs2.C_LINE_COMMENT_MODE,
        hljs2.C_BLOCK_COMMENT_MODE,
        hljs2.COMMENT(
          "/\\*\\*",
          "\\*/",
          {
            relevance: 0,
            contains: [
              {
                // eat up @'s in emails to prevent them to be recognized as doctags
                begin: /\w+@/,
                relevance: 0
              },
              {
                className: "doctag",
                begin: "@[A-Za-z]+"
              }
            ]
          }
        )
      ]);
      const REGEXP = {
        className: "regexp",
        begin: /~?\/[^\/\n]+\//,
        contains: [hljs2.BACKSLASH_ESCAPE]
      };
      const NUMBER = variants([
        hljs2.BINARY_NUMBER_MODE,
        hljs2.C_NUMBER_MODE
      ]);
      const STRING = variants(
        [
          {
            begin: /"""/,
            end: /"""/
          },
          {
            begin: /'''/,
            end: /'''/
          },
          {
            begin: "\\$/",
            end: "/\\$",
            relevance: 10
          },
          hljs2.APOS_STRING_MODE,
          hljs2.QUOTE_STRING_MODE
        ],
        {
          className: "string"
        }
      );
      return {
        name: "Groovy",
        keywords: {
          built_in: "this super",
          literal: "true false null",
          keyword: "byte short char int long boolean float double void def as in assert trait abstract static volatile transient public private protected synchronized final class interface enum if else for while switch case break default continue throw throws try catch finally implements extends new import package return instanceof"
        },
        contains: [
          hljs2.SHEBANG({
            binary: "groovy",
            relevance: 10
          }),
          COMMENT,
          STRING,
          REGEXP,
          NUMBER,
          {
            className: "class",
            beginKeywords: "class interface trait enum",
            end: /\{/,
            illegal: ":",
            contains: [
              {
                beginKeywords: "extends implements"
              },
              hljs2.UNDERSCORE_TITLE_MODE
            ]
          },
          {
            className: "meta",
            begin: "@[A-Za-z]+",
            relevance: 0
          },
          {
            // highlight map keys and named parameters as attrs
            className: "attr",
            begin: IDENT_RE + "[ 	]*:",
            relevance: 0
          },
          {
            // catch middle element of the ternary operator
            // to avoid highlight it as a label, named parameter, or map key
            begin: /\?/,
            end: /:/,
            relevance: 0,
            contains: [
              COMMENT,
              STRING,
              REGEXP,
              NUMBER,
              "self"
            ]
          },
          {
            // highlight labeled statements
            className: "symbol",
            begin: "^[ 	]*" + lookahead(IDENT_RE + ":"),
            excludeBegin: true,
            end: IDENT_RE + ":",
            relevance: 0
          }
        ],
        illegal: /#|<\//
      };
    }
    module.exports = groovy2;
  }
});

// node_modules/highlight.js/lib/languages/java.js
var require_java = __commonJS({
  "node_modules/highlight.js/lib/languages/java.js"(exports, module) {
    var decimalDigits = "[0-9](_*[0-9])*";
    var frac = `\\.(${decimalDigits})`;
    var hexDigits = "[0-9a-fA-F](_*[0-9a-fA-F])*";
    var NUMERIC = {
      className: "number",
      variants: [
        // DecimalFloatingPointLiteral
        // including ExponentPart
        { begin: `(\\b(${decimalDigits})((${frac})|\\.)?|(${frac}))[eE][+-]?(${decimalDigits})[fFdD]?\\b` },
        // excluding ExponentPart
        { begin: `\\b(${decimalDigits})((${frac})[fFdD]?\\b|\\.([fFdD]\\b)?)` },
        { begin: `(${frac})[fFdD]?\\b` },
        { begin: `\\b(${decimalDigits})[fFdD]\\b` },
        // HexadecimalFloatingPointLiteral
        { begin: `\\b0[xX]((${hexDigits})\\.?|(${hexDigits})?\\.(${hexDigits}))[pP][+-]?(${decimalDigits})[fFdD]?\\b` },
        // DecimalIntegerLiteral
        { begin: "\\b(0|[1-9](_*[0-9])*)[lL]?\\b" },
        // HexIntegerLiteral
        { begin: `\\b0[xX](${hexDigits})[lL]?\\b` },
        // OctalIntegerLiteral
        { begin: "\\b0(_*[0-7])*[lL]?\\b" },
        // BinaryIntegerLiteral
        { begin: "\\b0[bB][01](_*[01])*[lL]?\\b" }
      ],
      relevance: 0
    };
    function java2(hljs2) {
      var JAVA_IDENT_RE = "[\xC0-\u02B8a-zA-Z_$][\xC0-\u02B8a-zA-Z_$0-9]*";
      var GENERIC_IDENT_RE = JAVA_IDENT_RE + "(<" + JAVA_IDENT_RE + "(\\s*,\\s*" + JAVA_IDENT_RE + ")*>)?";
      var KEYWORDS = "false synchronized int abstract float private char boolean var static null if const for true while long strictfp finally protected import native final void enum else break transient catch instanceof byte super volatile case assert short package default double public try this switch continue throws protected public private module requires exports do";
      var ANNOTATION = {
        className: "meta",
        begin: "@" + JAVA_IDENT_RE,
        contains: [
          {
            begin: /\(/,
            end: /\)/,
            contains: ["self"]
            // allow nested () inside our annotation
          }
        ]
      };
      const NUMBER = NUMERIC;
      return {
        name: "Java",
        aliases: ["jsp"],
        keywords: KEYWORDS,
        illegal: /<\/|#/,
        contains: [
          hljs2.COMMENT(
            "/\\*\\*",
            "\\*/",
            {
              relevance: 0,
              contains: [
                {
                  // eat up @'s in emails to prevent them to be recognized as doctags
                  begin: /\w+@/,
                  relevance: 0
                },
                {
                  className: "doctag",
                  begin: "@[A-Za-z]+"
                }
              ]
            }
          ),
          // relevance boost
          {
            begin: /import java\.[a-z]+\./,
            keywords: "import",
            relevance: 2
          },
          hljs2.C_LINE_COMMENT_MODE,
          hljs2.C_BLOCK_COMMENT_MODE,
          hljs2.APOS_STRING_MODE,
          hljs2.QUOTE_STRING_MODE,
          {
            className: "class",
            beginKeywords: "class interface enum",
            end: /[{;=]/,
            excludeEnd: true,
            // TODO: can this be removed somehow?
            // an extra boost because Java is more popular than other languages with
            // this same syntax feature (this is just to preserve our tests passing
            // for now)
            relevance: 1,
            keywords: "class interface enum",
            illegal: /[:"\[\]]/,
            contains: [
              { beginKeywords: "extends implements" },
              hljs2.UNDERSCORE_TITLE_MODE
            ]
          },
          {
            // Expression keywords prevent 'keyword Name(...)' from being
            // recognized as a function definition
            beginKeywords: "new throw return else",
            relevance: 0
          },
          {
            className: "class",
            begin: "record\\s+" + hljs2.UNDERSCORE_IDENT_RE + "\\s*\\(",
            returnBegin: true,
            excludeEnd: true,
            end: /[{;=]/,
            keywords: KEYWORDS,
            contains: [
              { beginKeywords: "record" },
              {
                begin: hljs2.UNDERSCORE_IDENT_RE + "\\s*\\(",
                returnBegin: true,
                relevance: 0,
                contains: [hljs2.UNDERSCORE_TITLE_MODE]
              },
              {
                className: "params",
                begin: /\(/,
                end: /\)/,
                keywords: KEYWORDS,
                relevance: 0,
                contains: [
                  hljs2.C_BLOCK_COMMENT_MODE
                ]
              },
              hljs2.C_LINE_COMMENT_MODE,
              hljs2.C_BLOCK_COMMENT_MODE
            ]
          },
          {
            className: "function",
            begin: "(" + GENERIC_IDENT_RE + "\\s+)+" + hljs2.UNDERSCORE_IDENT_RE + "\\s*\\(",
            returnBegin: true,
            end: /[{;=]/,
            excludeEnd: true,
            keywords: KEYWORDS,
            contains: [
              {
                begin: hljs2.UNDERSCORE_IDENT_RE + "\\s*\\(",
                returnBegin: true,
                relevance: 0,
                contains: [hljs2.UNDERSCORE_TITLE_MODE]
              },
              {
                className: "params",
                begin: /\(/,
                end: /\)/,
                keywords: KEYWORDS,
                relevance: 0,
                contains: [
                  ANNOTATION,
                  hljs2.APOS_STRING_MODE,
                  hljs2.QUOTE_STRING_MODE,
                  NUMBER,
                  hljs2.C_BLOCK_COMMENT_MODE
                ]
              },
              hljs2.C_LINE_COMMENT_MODE,
              hljs2.C_BLOCK_COMMENT_MODE
            ]
          },
          NUMBER,
          ANNOTATION
        ]
      };
    }
    module.exports = java2;
  }
});

// node_modules/highlight.js/lib/languages/javascript.js
var require_javascript = __commonJS({
  "node_modules/highlight.js/lib/languages/javascript.js"(exports, module) {
    var IDENT_RE = "[A-Za-z$_][0-9A-Za-z$_]*";
    var KEYWORDS = [
      "as",
      // for exports
      "in",
      "of",
      "if",
      "for",
      "while",
      "finally",
      "var",
      "new",
      "function",
      "do",
      "return",
      "void",
      "else",
      "break",
      "catch",
      "instanceof",
      "with",
      "throw",
      "case",
      "default",
      "try",
      "switch",
      "continue",
      "typeof",
      "delete",
      "let",
      "yield",
      "const",
      "class",
      // JS handles these with a special rule
      // "get",
      // "set",
      "debugger",
      "async",
      "await",
      "static",
      "import",
      "from",
      "export",
      "extends"
    ];
    var LITERALS = [
      "true",
      "false",
      "null",
      "undefined",
      "NaN",
      "Infinity"
    ];
    var TYPES = [
      "Intl",
      "DataView",
      "Number",
      "Math",
      "Date",
      "String",
      "RegExp",
      "Object",
      "Function",
      "Boolean",
      "Error",
      "Symbol",
      "Set",
      "Map",
      "WeakSet",
      "WeakMap",
      "Proxy",
      "Reflect",
      "JSON",
      "Promise",
      "Float64Array",
      "Int16Array",
      "Int32Array",
      "Int8Array",
      "Uint16Array",
      "Uint32Array",
      "Float32Array",
      "Array",
      "Uint8Array",
      "Uint8ClampedArray",
      "ArrayBuffer",
      "BigInt64Array",
      "BigUint64Array",
      "BigInt"
    ];
    var ERROR_TYPES = [
      "EvalError",
      "InternalError",
      "RangeError",
      "ReferenceError",
      "SyntaxError",
      "TypeError",
      "URIError"
    ];
    var BUILT_IN_GLOBALS = [
      "setInterval",
      "setTimeout",
      "clearInterval",
      "clearTimeout",
      "require",
      "exports",
      "eval",
      "isFinite",
      "isNaN",
      "parseFloat",
      "parseInt",
      "decodeURI",
      "decodeURIComponent",
      "encodeURI",
      "encodeURIComponent",
      "escape",
      "unescape"
    ];
    var BUILT_IN_VARIABLES = [
      "arguments",
      "this",
      "super",
      "console",
      "window",
      "document",
      "localStorage",
      "module",
      "global"
      // Node.js
    ];
    var BUILT_INS = [].concat(
      BUILT_IN_GLOBALS,
      BUILT_IN_VARIABLES,
      TYPES,
      ERROR_TYPES
    );
    function source(re) {
      if (!re) return null;
      if (typeof re === "string") return re;
      return re.source;
    }
    function lookahead(re) {
      return concat("(?=", re, ")");
    }
    function concat(...args) {
      const joined = args.map((x) => source(x)).join("");
      return joined;
    }
    function javascript2(hljs2) {
      const hasClosingTag = (match, { after }) => {
        const tag = "</" + match[0].slice(1);
        const pos = match.input.indexOf(tag, after);
        return pos !== -1;
      };
      const IDENT_RE$1 = IDENT_RE;
      const FRAGMENT = {
        begin: "<>",
        end: "</>"
      };
      const XML_TAG = {
        begin: /<[A-Za-z0-9\\._:-]+/,
        end: /\/[A-Za-z0-9\\._:-]+>|\/>/,
        /**
         * @param {RegExpMatchArray} match
         * @param {CallbackResponse} response
         */
        isTrulyOpeningTag: (match, response) => {
          const afterMatchIndex = match[0].length + match.index;
          const nextChar = match.input[afterMatchIndex];
          if (nextChar === "<") {
            response.ignoreMatch();
            return;
          }
          if (nextChar === ">") {
            if (!hasClosingTag(match, { after: afterMatchIndex })) {
              response.ignoreMatch();
            }
          }
        }
      };
      const KEYWORDS$1 = {
        $pattern: IDENT_RE,
        keyword: KEYWORDS,
        literal: LITERALS,
        built_in: BUILT_INS
      };
      const decimalDigits = "[0-9](_?[0-9])*";
      const frac = `\\.(${decimalDigits})`;
      const decimalInteger = `0|[1-9](_?[0-9])*|0[0-7]*[89][0-9]*`;
      const NUMBER = {
        className: "number",
        variants: [
          // DecimalLiteral
          { begin: `(\\b(${decimalInteger})((${frac})|\\.)?|(${frac}))[eE][+-]?(${decimalDigits})\\b` },
          { begin: `\\b(${decimalInteger})\\b((${frac})\\b|\\.)?|(${frac})\\b` },
          // DecimalBigIntegerLiteral
          { begin: `\\b(0|[1-9](_?[0-9])*)n\\b` },
          // NonDecimalIntegerLiteral
          { begin: "\\b0[xX][0-9a-fA-F](_?[0-9a-fA-F])*n?\\b" },
          { begin: "\\b0[bB][0-1](_?[0-1])*n?\\b" },
          { begin: "\\b0[oO][0-7](_?[0-7])*n?\\b" },
          // LegacyOctalIntegerLiteral (does not include underscore separators)
          // https://tc39.es/ecma262/#sec-additional-syntax-numeric-literals
          { begin: "\\b0[0-7]+n?\\b" }
        ],
        relevance: 0
      };
      const SUBST = {
        className: "subst",
        begin: "\\$\\{",
        end: "\\}",
        keywords: KEYWORDS$1,
        contains: []
        // defined later
      };
      const HTML_TEMPLATE = {
        begin: "html`",
        end: "",
        starts: {
          end: "`",
          returnEnd: false,
          contains: [
            hljs2.BACKSLASH_ESCAPE,
            SUBST
          ],
          subLanguage: "xml"
        }
      };
      const CSS_TEMPLATE = {
        begin: "css`",
        end: "",
        starts: {
          end: "`",
          returnEnd: false,
          contains: [
            hljs2.BACKSLASH_ESCAPE,
            SUBST
          ],
          subLanguage: "css"
        }
      };
      const TEMPLATE_STRING = {
        className: "string",
        begin: "`",
        end: "`",
        contains: [
          hljs2.BACKSLASH_ESCAPE,
          SUBST
        ]
      };
      const JSDOC_COMMENT = hljs2.COMMENT(
        /\/\*\*(?!\/)/,
        "\\*/",
        {
          relevance: 0,
          contains: [
            {
              className: "doctag",
              begin: "@[A-Za-z]+",
              contains: [
                {
                  className: "type",
                  begin: "\\{",
                  end: "\\}",
                  relevance: 0
                },
                {
                  className: "variable",
                  begin: IDENT_RE$1 + "(?=\\s*(-)|$)",
                  endsParent: true,
                  relevance: 0
                },
                // eat spaces (not newlines) so we can find
                // types or variables
                {
                  begin: /(?=[^\n])\s/,
                  relevance: 0
                }
              ]
            }
          ]
        }
      );
      const COMMENT = {
        className: "comment",
        variants: [
          JSDOC_COMMENT,
          hljs2.C_BLOCK_COMMENT_MODE,
          hljs2.C_LINE_COMMENT_MODE
        ]
      };
      const SUBST_INTERNALS = [
        hljs2.APOS_STRING_MODE,
        hljs2.QUOTE_STRING_MODE,
        HTML_TEMPLATE,
        CSS_TEMPLATE,
        TEMPLATE_STRING,
        NUMBER,
        hljs2.REGEXP_MODE
      ];
      SUBST.contains = SUBST_INTERNALS.concat({
        // we need to pair up {} inside our subst to prevent
        // it from ending too early by matching another }
        begin: /\{/,
        end: /\}/,
        keywords: KEYWORDS$1,
        contains: [
          "self"
        ].concat(SUBST_INTERNALS)
      });
      const SUBST_AND_COMMENTS = [].concat(COMMENT, SUBST.contains);
      const PARAMS_CONTAINS = SUBST_AND_COMMENTS.concat([
        // eat recursive parens in sub expressions
        {
          begin: /\(/,
          end: /\)/,
          keywords: KEYWORDS$1,
          contains: ["self"].concat(SUBST_AND_COMMENTS)
        }
      ]);
      const PARAMS = {
        className: "params",
        begin: /\(/,
        end: /\)/,
        excludeBegin: true,
        excludeEnd: true,
        keywords: KEYWORDS$1,
        contains: PARAMS_CONTAINS
      };
      return {
        name: "Javascript",
        aliases: ["js", "jsx", "mjs", "cjs"],
        keywords: KEYWORDS$1,
        // this will be extended by TypeScript
        exports: { PARAMS_CONTAINS },
        illegal: /#(?![$_A-z])/,
        contains: [
          hljs2.SHEBANG({
            label: "shebang",
            binary: "node",
            relevance: 5
          }),
          {
            label: "use_strict",
            className: "meta",
            relevance: 10,
            begin: /^\s*['"]use (strict|asm)['"]/
          },
          hljs2.APOS_STRING_MODE,
          hljs2.QUOTE_STRING_MODE,
          HTML_TEMPLATE,
          CSS_TEMPLATE,
          TEMPLATE_STRING,
          COMMENT,
          NUMBER,
          {
            // object attr container
            begin: concat(
              /[{,\n]\s*/,
              // we need to look ahead to make sure that we actually have an
              // attribute coming up so we don't steal a comma from a potential
              // "value" container
              //
              // NOTE: this might not work how you think.  We don't actually always
              // enter this mode and stay.  Instead it might merely match `,
              // <comments up next>` and then immediately end after the , because it
              // fails to find any actual attrs. But this still does the job because
              // it prevents the value contain rule from grabbing this instead and
              // prevening this rule from firing when we actually DO have keys.
              lookahead(concat(
                // we also need to allow for multiple possible comments inbetween
                // the first key:value pairing
                /(((\/\/.*$)|(\/\*(\*[^/]|[^*])*\*\/))\s*)*/,
                IDENT_RE$1 + "\\s*:"
              ))
            ),
            relevance: 0,
            contains: [
              {
                className: "attr",
                begin: IDENT_RE$1 + lookahead("\\s*:"),
                relevance: 0
              }
            ]
          },
          {
            // "value" container
            begin: "(" + hljs2.RE_STARTERS_RE + "|\\b(case|return|throw)\\b)\\s*",
            keywords: "return throw case",
            contains: [
              COMMENT,
              hljs2.REGEXP_MODE,
              {
                className: "function",
                // we have to count the parens to make sure we actually have the
                // correct bounding ( ) before the =>.  There could be any number of
                // sub-expressions inside also surrounded by parens.
                begin: "(\\([^()]*(\\([^()]*(\\([^()]*\\)[^()]*)*\\)[^()]*)*\\)|" + hljs2.UNDERSCORE_IDENT_RE + ")\\s*=>",
                returnBegin: true,
                end: "\\s*=>",
                contains: [
                  {
                    className: "params",
                    variants: [
                      {
                        begin: hljs2.UNDERSCORE_IDENT_RE,
                        relevance: 0
                      },
                      {
                        className: null,
                        begin: /\(\s*\)/,
                        skip: true
                      },
                      {
                        begin: /\(/,
                        end: /\)/,
                        excludeBegin: true,
                        excludeEnd: true,
                        keywords: KEYWORDS$1,
                        contains: PARAMS_CONTAINS
                      }
                    ]
                  }
                ]
              },
              {
                // could be a comma delimited list of params to a function call
                begin: /,/,
                relevance: 0
              },
              {
                className: "",
                begin: /\s/,
                end: /\s*/,
                skip: true
              },
              {
                // JSX
                variants: [
                  { begin: FRAGMENT.begin, end: FRAGMENT.end },
                  {
                    begin: XML_TAG.begin,
                    // we carefully check the opening tag to see if it truly
                    // is a tag and not a false positive
                    "on:begin": XML_TAG.isTrulyOpeningTag,
                    end: XML_TAG.end
                  }
                ],
                subLanguage: "xml",
                contains: [
                  {
                    begin: XML_TAG.begin,
                    end: XML_TAG.end,
                    skip: true,
                    contains: ["self"]
                  }
                ]
              }
            ],
            relevance: 0
          },
          {
            className: "function",
            beginKeywords: "function",
            end: /[{;]/,
            excludeEnd: true,
            keywords: KEYWORDS$1,
            contains: [
              "self",
              hljs2.inherit(hljs2.TITLE_MODE, { begin: IDENT_RE$1 }),
              PARAMS
            ],
            illegal: /%/
          },
          {
            // prevent this from getting swallowed up by function
            // since they appear "function like"
            beginKeywords: "while if switch catch for"
          },
          {
            className: "function",
            // we have to count the parens to make sure we actually have the correct
            // bounding ( ).  There could be any number of sub-expressions inside
            // also surrounded by parens.
            begin: hljs2.UNDERSCORE_IDENT_RE + "\\([^()]*(\\([^()]*(\\([^()]*\\)[^()]*)*\\)[^()]*)*\\)\\s*\\{",
            // end parens
            returnBegin: true,
            contains: [
              PARAMS,
              hljs2.inherit(hljs2.TITLE_MODE, { begin: IDENT_RE$1 })
            ]
          },
          // hack: prevents detection of keywords in some circumstances
          // .keyword()
          // $keyword = x
          {
            variants: [
              { begin: "\\." + IDENT_RE$1 },
              { begin: "\\$" + IDENT_RE$1 }
            ],
            relevance: 0
          },
          {
            // ES6 class
            className: "class",
            beginKeywords: "class",
            end: /[{;=]/,
            excludeEnd: true,
            illegal: /[:"[\]]/,
            contains: [
              { beginKeywords: "extends" },
              hljs2.UNDERSCORE_TITLE_MODE
            ]
          },
          {
            begin: /\b(?=constructor)/,
            end: /[{;]/,
            excludeEnd: true,
            contains: [
              hljs2.inherit(hljs2.TITLE_MODE, { begin: IDENT_RE$1 }),
              "self",
              PARAMS
            ]
          },
          {
            begin: "(get|set)\\s+(?=" + IDENT_RE$1 + "\\()",
            end: /\{/,
            keywords: "get set",
            contains: [
              hljs2.inherit(hljs2.TITLE_MODE, { begin: IDENT_RE$1 }),
              { begin: /\(\)/ },
              // eat to avoid empty params
              PARAMS
            ]
          },
          {
            begin: /\$[(.]/
            // relevance booster for a pattern common to JS libs: `$(something)` and `$.something`
          }
        ]
      };
    }
    module.exports = javascript2;
  }
});

// node_modules/highlight.js/lib/languages/json.js
var require_json = __commonJS({
  "node_modules/highlight.js/lib/languages/json.js"(exports, module) {
    function json2(hljs2) {
      const LITERALS = {
        literal: "true false null"
      };
      const ALLOWED_COMMENTS = [
        hljs2.C_LINE_COMMENT_MODE,
        hljs2.C_BLOCK_COMMENT_MODE
      ];
      const TYPES = [
        hljs2.QUOTE_STRING_MODE,
        hljs2.C_NUMBER_MODE
      ];
      const VALUE_CONTAINER = {
        end: ",",
        endsWithParent: true,
        excludeEnd: true,
        contains: TYPES,
        keywords: LITERALS
      };
      const OBJECT = {
        begin: /\{/,
        end: /\}/,
        contains: [
          {
            className: "attr",
            begin: /"/,
            end: /"/,
            contains: [hljs2.BACKSLASH_ESCAPE],
            illegal: "\\n"
          },
          hljs2.inherit(VALUE_CONTAINER, {
            begin: /:/
          })
        ].concat(ALLOWED_COMMENTS),
        illegal: "\\S"
      };
      const ARRAY = {
        begin: "\\[",
        end: "\\]",
        contains: [hljs2.inherit(VALUE_CONTAINER)],
        // inherit is a workaround for a bug that makes shared modes with endsWithParent compile only the ending of one of the parents
        illegal: "\\S"
      };
      TYPES.push(OBJECT, ARRAY);
      ALLOWED_COMMENTS.forEach(function(rule) {
        TYPES.push(rule);
      });
      return {
        name: "JSON",
        contains: TYPES,
        keywords: LITERALS,
        illegal: "\\S"
      };
    }
    module.exports = json2;
  }
});

// node_modules/highlight.js/lib/languages/kotlin.js
var require_kotlin = __commonJS({
  "node_modules/highlight.js/lib/languages/kotlin.js"(exports, module) {
    var decimalDigits = "[0-9](_*[0-9])*";
    var frac = `\\.(${decimalDigits})`;
    var hexDigits = "[0-9a-fA-F](_*[0-9a-fA-F])*";
    var NUMERIC = {
      className: "number",
      variants: [
        // DecimalFloatingPointLiteral
        // including ExponentPart
        { begin: `(\\b(${decimalDigits})((${frac})|\\.)?|(${frac}))[eE][+-]?(${decimalDigits})[fFdD]?\\b` },
        // excluding ExponentPart
        { begin: `\\b(${decimalDigits})((${frac})[fFdD]?\\b|\\.([fFdD]\\b)?)` },
        { begin: `(${frac})[fFdD]?\\b` },
        { begin: `\\b(${decimalDigits})[fFdD]\\b` },
        // HexadecimalFloatingPointLiteral
        { begin: `\\b0[xX]((${hexDigits})\\.?|(${hexDigits})?\\.(${hexDigits}))[pP][+-]?(${decimalDigits})[fFdD]?\\b` },
        // DecimalIntegerLiteral
        { begin: "\\b(0|[1-9](_*[0-9])*)[lL]?\\b" },
        // HexIntegerLiteral
        { begin: `\\b0[xX](${hexDigits})[lL]?\\b` },
        // OctalIntegerLiteral
        { begin: "\\b0(_*[0-7])*[lL]?\\b" },
        // BinaryIntegerLiteral
        { begin: "\\b0[bB][01](_*[01])*[lL]?\\b" }
      ],
      relevance: 0
    };
    function kotlin2(hljs2) {
      const KEYWORDS = {
        keyword: "abstract as val var vararg get set class object open private protected public noinline crossinline dynamic final enum if else do while for when throw try catch finally import package is in fun override companion reified inline lateinit init interface annotation data sealed internal infix operator out by constructor super tailrec where const inner suspend typealias external expect actual",
        built_in: "Byte Short Char Int Long Boolean Float Double Void Unit Nothing",
        literal: "true false null"
      };
      const KEYWORDS_WITH_LABEL = {
        className: "keyword",
        begin: /\b(break|continue|return|this)\b/,
        starts: {
          contains: [
            {
              className: "symbol",
              begin: /@\w+/
            }
          ]
        }
      };
      const LABEL = {
        className: "symbol",
        begin: hljs2.UNDERSCORE_IDENT_RE + "@"
      };
      const SUBST = {
        className: "subst",
        begin: /\$\{/,
        end: /\}/,
        contains: [hljs2.C_NUMBER_MODE]
      };
      const VARIABLE = {
        className: "variable",
        begin: "\\$" + hljs2.UNDERSCORE_IDENT_RE
      };
      const STRING = {
        className: "string",
        variants: [
          {
            begin: '"""',
            end: '"""(?=[^"])',
            contains: [
              VARIABLE,
              SUBST
            ]
          },
          // Can't use built-in modes easily, as we want to use STRING in the meta
          // context as 'meta-string' and there's no syntax to remove explicitly set
          // classNames in built-in modes.
          {
            begin: "'",
            end: "'",
            illegal: /\n/,
            contains: [hljs2.BACKSLASH_ESCAPE]
          },
          {
            begin: '"',
            end: '"',
            illegal: /\n/,
            contains: [
              hljs2.BACKSLASH_ESCAPE,
              VARIABLE,
              SUBST
            ]
          }
        ]
      };
      SUBST.contains.push(STRING);
      const ANNOTATION_USE_SITE = {
        className: "meta",
        begin: "@(?:file|property|field|get|set|receiver|param|setparam|delegate)\\s*:(?:\\s*" + hljs2.UNDERSCORE_IDENT_RE + ")?"
      };
      const ANNOTATION = {
        className: "meta",
        begin: "@" + hljs2.UNDERSCORE_IDENT_RE,
        contains: [
          {
            begin: /\(/,
            end: /\)/,
            contains: [
              hljs2.inherit(STRING, {
                className: "meta-string"
              })
            ]
          }
        ]
      };
      const KOTLIN_NUMBER_MODE = NUMERIC;
      const KOTLIN_NESTED_COMMENT = hljs2.COMMENT(
        "/\\*",
        "\\*/",
        {
          contains: [hljs2.C_BLOCK_COMMENT_MODE]
        }
      );
      const KOTLIN_PAREN_TYPE = {
        variants: [
          {
            className: "type",
            begin: hljs2.UNDERSCORE_IDENT_RE
          },
          {
            begin: /\(/,
            end: /\)/,
            contains: []
            // defined later
          }
        ]
      };
      const KOTLIN_PAREN_TYPE2 = KOTLIN_PAREN_TYPE;
      KOTLIN_PAREN_TYPE2.variants[1].contains = [KOTLIN_PAREN_TYPE];
      KOTLIN_PAREN_TYPE.variants[1].contains = [KOTLIN_PAREN_TYPE2];
      return {
        name: "Kotlin",
        aliases: ["kt", "kts"],
        keywords: KEYWORDS,
        contains: [
          hljs2.COMMENT(
            "/\\*\\*",
            "\\*/",
            {
              relevance: 0,
              contains: [
                {
                  className: "doctag",
                  begin: "@[A-Za-z]+"
                }
              ]
            }
          ),
          hljs2.C_LINE_COMMENT_MODE,
          KOTLIN_NESTED_COMMENT,
          KEYWORDS_WITH_LABEL,
          LABEL,
          ANNOTATION_USE_SITE,
          ANNOTATION,
          {
            className: "function",
            beginKeywords: "fun",
            end: "[(]|$",
            returnBegin: true,
            excludeEnd: true,
            keywords: KEYWORDS,
            relevance: 5,
            contains: [
              {
                begin: hljs2.UNDERSCORE_IDENT_RE + "\\s*\\(",
                returnBegin: true,
                relevance: 0,
                contains: [hljs2.UNDERSCORE_TITLE_MODE]
              },
              {
                className: "type",
                begin: /</,
                end: />/,
                keywords: "reified",
                relevance: 0
              },
              {
                className: "params",
                begin: /\(/,
                end: /\)/,
                endsParent: true,
                keywords: KEYWORDS,
                relevance: 0,
                contains: [
                  {
                    begin: /:/,
                    end: /[=,\/]/,
                    endsWithParent: true,
                    contains: [
                      KOTLIN_PAREN_TYPE,
                      hljs2.C_LINE_COMMENT_MODE,
                      KOTLIN_NESTED_COMMENT
                    ],
                    relevance: 0
                  },
                  hljs2.C_LINE_COMMENT_MODE,
                  KOTLIN_NESTED_COMMENT,
                  ANNOTATION_USE_SITE,
                  ANNOTATION,
                  STRING,
                  hljs2.C_NUMBER_MODE
                ]
              },
              KOTLIN_NESTED_COMMENT
            ]
          },
          {
            className: "class",
            beginKeywords: "class interface trait",
            // remove 'trait' when removed from KEYWORDS
            end: /[:\{(]|$/,
            excludeEnd: true,
            illegal: "extends implements",
            contains: [
              {
                beginKeywords: "public protected internal private constructor"
              },
              hljs2.UNDERSCORE_TITLE_MODE,
              {
                className: "type",
                begin: /</,
                end: />/,
                excludeBegin: true,
                excludeEnd: true,
                relevance: 0
              },
              {
                className: "type",
                begin: /[,:]\s*/,
                end: /[<\(,]|$/,
                excludeBegin: true,
                returnEnd: true
              },
              ANNOTATION_USE_SITE,
              ANNOTATION
            ]
          },
          STRING,
          {
            className: "meta",
            begin: "^#!/usr/bin/env",
            end: "$",
            illegal: "\n"
          },
          KOTLIN_NUMBER_MODE
        ]
      };
    }
    module.exports = kotlin2;
  }
});

// node_modules/highlight.js/lib/languages/lua.js
var require_lua = __commonJS({
  "node_modules/highlight.js/lib/languages/lua.js"(exports, module) {
    function lua2(hljs2) {
      const OPENING_LONG_BRACKET = "\\[=*\\[";
      const CLOSING_LONG_BRACKET = "\\]=*\\]";
      const LONG_BRACKETS = {
        begin: OPENING_LONG_BRACKET,
        end: CLOSING_LONG_BRACKET,
        contains: ["self"]
      };
      const COMMENTS = [
        hljs2.COMMENT("--(?!" + OPENING_LONG_BRACKET + ")", "$"),
        hljs2.COMMENT(
          "--" + OPENING_LONG_BRACKET,
          CLOSING_LONG_BRACKET,
          {
            contains: [LONG_BRACKETS],
            relevance: 10
          }
        )
      ];
      return {
        name: "Lua",
        keywords: {
          $pattern: hljs2.UNDERSCORE_IDENT_RE,
          literal: "true false nil",
          keyword: "and break do else elseif end for goto if in local not or repeat return then until while",
          built_in: (
            // Metatags and globals:
            "_G _ENV _VERSION __index __newindex __mode __call __metatable __tostring __len __gc __add __sub __mul __div __mod __pow __concat __unm __eq __lt __le assert collectgarbage dofile error getfenv getmetatable ipairs load loadfile loadstring module next pairs pcall print rawequal rawget rawset require select setfenv setmetatable tonumber tostring type unpack xpcall arg self coroutine resume yield status wrap create running debug getupvalue debug sethook getmetatable gethook setmetatable setlocal traceback setfenv getinfo setupvalue getlocal getregistry getfenv io lines write close flush open output type read stderr stdin input stdout popen tmpfile math log max acos huge ldexp pi cos tanh pow deg tan cosh sinh random randomseed frexp ceil floor rad abs sqrt modf asin min mod fmod log10 atan2 exp sin atan os exit setlocale date getenv difftime remove time clock tmpname rename execute package preload loadlib loaded loaders cpath config path seeall string sub upper len gfind rep find match char dump gmatch reverse byte format gsub lower table setn insert getn foreachi maxn foreach concat sort remove"
          )
        },
        contains: COMMENTS.concat([
          {
            className: "function",
            beginKeywords: "function",
            end: "\\)",
            contains: [
              hljs2.inherit(hljs2.TITLE_MODE, {
                begin: "([_a-zA-Z]\\w*\\.)*([_a-zA-Z]\\w*:)?[_a-zA-Z]\\w*"
              }),
              {
                className: "params",
                begin: "\\(",
                endsWithParent: true,
                contains: COMMENTS
              }
            ].concat(COMMENTS)
          },
          hljs2.C_NUMBER_MODE,
          hljs2.APOS_STRING_MODE,
          hljs2.QUOTE_STRING_MODE,
          {
            className: "string",
            begin: OPENING_LONG_BRACKET,
            end: CLOSING_LONG_BRACKET,
            contains: [LONG_BRACKETS],
            relevance: 5
          }
        ])
      };
    }
    module.exports = lua2;
  }
});

// node_modules/highlight.js/lib/languages/nix.js
var require_nix = __commonJS({
  "node_modules/highlight.js/lib/languages/nix.js"(exports, module) {
    function nix2(hljs2) {
      const NIX_KEYWORDS = {
        keyword: "rec with let in inherit assert if else then",
        literal: "true false or and null",
        built_in: "import abort baseNameOf dirOf isNull builtins map removeAttrs throw toString derivation"
      };
      const ANTIQUOTE = {
        className: "subst",
        begin: /\$\{/,
        end: /\}/,
        keywords: NIX_KEYWORDS
      };
      const ATTRS = {
        begin: /[a-zA-Z0-9-_]+(\s*=)/,
        returnBegin: true,
        relevance: 0,
        contains: [
          {
            className: "attr",
            begin: /\S+/
          }
        ]
      };
      const STRING = {
        className: "string",
        contains: [ANTIQUOTE],
        variants: [
          {
            begin: "''",
            end: "''"
          },
          {
            begin: '"',
            end: '"'
          }
        ]
      };
      const EXPRESSIONS = [
        hljs2.NUMBER_MODE,
        hljs2.HASH_COMMENT_MODE,
        hljs2.C_BLOCK_COMMENT_MODE,
        STRING,
        ATTRS
      ];
      ANTIQUOTE.contains = EXPRESSIONS;
      return {
        name: "Nix",
        aliases: ["nixos"],
        keywords: NIX_KEYWORDS,
        contains: EXPRESSIONS
      };
    }
    module.exports = nix2;
  }
});

// node_modules/highlight.js/lib/languages/perl.js
var require_perl = __commonJS({
  "node_modules/highlight.js/lib/languages/perl.js"(exports, module) {
    function source(re) {
      if (!re) return null;
      if (typeof re === "string") return re;
      return re.source;
    }
    function concat(...args) {
      const joined = args.map((x) => source(x)).join("");
      return joined;
    }
    function either(...args) {
      const joined = "(" + args.map((x) => source(x)).join("|") + ")";
      return joined;
    }
    function perl2(hljs2) {
      const KEYWORDS = [
        "abs",
        "accept",
        "alarm",
        "and",
        "atan2",
        "bind",
        "binmode",
        "bless",
        "break",
        "caller",
        "chdir",
        "chmod",
        "chomp",
        "chop",
        "chown",
        "chr",
        "chroot",
        "close",
        "closedir",
        "connect",
        "continue",
        "cos",
        "crypt",
        "dbmclose",
        "dbmopen",
        "defined",
        "delete",
        "die",
        "do",
        "dump",
        "each",
        "else",
        "elsif",
        "endgrent",
        "endhostent",
        "endnetent",
        "endprotoent",
        "endpwent",
        "endservent",
        "eof",
        "eval",
        "exec",
        "exists",
        "exit",
        "exp",
        "fcntl",
        "fileno",
        "flock",
        "for",
        "foreach",
        "fork",
        "format",
        "formline",
        "getc",
        "getgrent",
        "getgrgid",
        "getgrnam",
        "gethostbyaddr",
        "gethostbyname",
        "gethostent",
        "getlogin",
        "getnetbyaddr",
        "getnetbyname",
        "getnetent",
        "getpeername",
        "getpgrp",
        "getpriority",
        "getprotobyname",
        "getprotobynumber",
        "getprotoent",
        "getpwent",
        "getpwnam",
        "getpwuid",
        "getservbyname",
        "getservbyport",
        "getservent",
        "getsockname",
        "getsockopt",
        "given",
        "glob",
        "gmtime",
        "goto",
        "grep",
        "gt",
        "hex",
        "if",
        "index",
        "int",
        "ioctl",
        "join",
        "keys",
        "kill",
        "last",
        "lc",
        "lcfirst",
        "length",
        "link",
        "listen",
        "local",
        "localtime",
        "log",
        "lstat",
        "lt",
        "ma",
        "map",
        "mkdir",
        "msgctl",
        "msgget",
        "msgrcv",
        "msgsnd",
        "my",
        "ne",
        "next",
        "no",
        "not",
        "oct",
        "open",
        "opendir",
        "or",
        "ord",
        "our",
        "pack",
        "package",
        "pipe",
        "pop",
        "pos",
        "print",
        "printf",
        "prototype",
        "push",
        "q|0",
        "qq",
        "quotemeta",
        "qw",
        "qx",
        "rand",
        "read",
        "readdir",
        "readline",
        "readlink",
        "readpipe",
        "recv",
        "redo",
        "ref",
        "rename",
        "require",
        "reset",
        "return",
        "reverse",
        "rewinddir",
        "rindex",
        "rmdir",
        "say",
        "scalar",
        "seek",
        "seekdir",
        "select",
        "semctl",
        "semget",
        "semop",
        "send",
        "setgrent",
        "sethostent",
        "setnetent",
        "setpgrp",
        "setpriority",
        "setprotoent",
        "setpwent",
        "setservent",
        "setsockopt",
        "shift",
        "shmctl",
        "shmget",
        "shmread",
        "shmwrite",
        "shutdown",
        "sin",
        "sleep",
        "socket",
        "socketpair",
        "sort",
        "splice",
        "split",
        "sprintf",
        "sqrt",
        "srand",
        "stat",
        "state",
        "study",
        "sub",
        "substr",
        "symlink",
        "syscall",
        "sysopen",
        "sysread",
        "sysseek",
        "system",
        "syswrite",
        "tell",
        "telldir",
        "tie",
        "tied",
        "time",
        "times",
        "tr",
        "truncate",
        "uc",
        "ucfirst",
        "umask",
        "undef",
        "unless",
        "unlink",
        "unpack",
        "unshift",
        "untie",
        "until",
        "use",
        "utime",
        "values",
        "vec",
        "wait",
        "waitpid",
        "wantarray",
        "warn",
        "when",
        "while",
        "write",
        "x|0",
        "xor",
        "y|0"
      ];
      const REGEX_MODIFIERS = /[dualxmsipngr]{0,12}/;
      const PERL_KEYWORDS = {
        $pattern: /[\w.]+/,
        keyword: KEYWORDS.join(" ")
      };
      const SUBST = {
        className: "subst",
        begin: "[$@]\\{",
        end: "\\}",
        keywords: PERL_KEYWORDS
      };
      const METHOD = {
        begin: /->\{/,
        end: /\}/
        // contains defined later
      };
      const VAR = {
        variants: [
          {
            begin: /\$\d/
          },
          {
            begin: concat(
              /[$%@](\^\w\b|#\w+(::\w+)*|\{\w+\}|\w+(::\w*)*)/,
              // negative look-ahead tries to avoid matching patterns that are not
              // Perl at all like $ident$, @ident@, etc.
              `(?![A-Za-z])(?![@$%])`
            )
          },
          {
            begin: /[$%@][^\s\w{]/,
            relevance: 0
          }
        ]
      };
      const STRING_CONTAINS = [
        hljs2.BACKSLASH_ESCAPE,
        SUBST,
        VAR
      ];
      const REGEX_DELIMS = [
        /!/,
        /\//,
        /\|/,
        /\?/,
        /'/,
        /"/,
        // valid but infrequent and weird
        /#/
        // valid but infrequent and weird
      ];
      const PAIRED_DOUBLE_RE = (prefix, open, close = "\\1") => {
        const middle = close === "\\1" ? close : concat(close, open);
        return concat(
          concat("(?:", prefix, ")"),
          open,
          /(?:\\.|[^\\\/])*?/,
          middle,
          /(?:\\.|[^\\\/])*?/,
          close,
          REGEX_MODIFIERS
        );
      };
      const PAIRED_RE = (prefix, open, close) => {
        return concat(
          concat("(?:", prefix, ")"),
          open,
          /(?:\\.|[^\\\/])*?/,
          close,
          REGEX_MODIFIERS
        );
      };
      const PERL_DEFAULT_CONTAINS = [
        VAR,
        hljs2.HASH_COMMENT_MODE,
        hljs2.COMMENT(
          /^=\w/,
          /=cut/,
          {
            endsWithParent: true
          }
        ),
        METHOD,
        {
          className: "string",
          contains: STRING_CONTAINS,
          variants: [
            {
              begin: "q[qwxr]?\\s*\\(",
              end: "\\)",
              relevance: 5
            },
            {
              begin: "q[qwxr]?\\s*\\[",
              end: "\\]",
              relevance: 5
            },
            {
              begin: "q[qwxr]?\\s*\\{",
              end: "\\}",
              relevance: 5
            },
            {
              begin: "q[qwxr]?\\s*\\|",
              end: "\\|",
              relevance: 5
            },
            {
              begin: "q[qwxr]?\\s*<",
              end: ">",
              relevance: 5
            },
            {
              begin: "qw\\s+q",
              end: "q",
              relevance: 5
            },
            {
              begin: "'",
              end: "'",
              contains: [hljs2.BACKSLASH_ESCAPE]
            },
            {
              begin: '"',
              end: '"'
            },
            {
              begin: "`",
              end: "`",
              contains: [hljs2.BACKSLASH_ESCAPE]
            },
            {
              begin: /\{\w+\}/,
              relevance: 0
            },
            {
              begin: "-?\\w+\\s*=>",
              relevance: 0
            }
          ]
        },
        {
          className: "number",
          begin: "(\\b0[0-7_]+)|(\\b0x[0-9a-fA-F_]+)|(\\b[1-9][0-9_]*(\\.[0-9_]+)?)|[0_]\\b",
          relevance: 0
        },
        {
          // regexp container
          begin: "(\\/\\/|" + hljs2.RE_STARTERS_RE + "|\\b(split|return|print|reverse|grep)\\b)\\s*",
          keywords: "split return print reverse grep",
          relevance: 0,
          contains: [
            hljs2.HASH_COMMENT_MODE,
            {
              className: "regexp",
              variants: [
                // allow matching common delimiters
                { begin: PAIRED_DOUBLE_RE("s|tr|y", either(...REGEX_DELIMS)) },
                // and then paired delmis
                { begin: PAIRED_DOUBLE_RE("s|tr|y", "\\(", "\\)") },
                { begin: PAIRED_DOUBLE_RE("s|tr|y", "\\[", "\\]") },
                { begin: PAIRED_DOUBLE_RE("s|tr|y", "\\{", "\\}") }
              ],
              relevance: 2
            },
            {
              className: "regexp",
              variants: [
                {
                  // could be a comment in many languages so do not count
                  // as relevant
                  begin: /(m|qr)\/\//,
                  relevance: 0
                },
                // prefix is optional with /regex/
                { begin: PAIRED_RE("(?:m|qr)?", /\//, /\//) },
                // allow matching common delimiters
                { begin: PAIRED_RE("m|qr", either(...REGEX_DELIMS), /\1/) },
                // allow common paired delmins
                { begin: PAIRED_RE("m|qr", /\(/, /\)/) },
                { begin: PAIRED_RE("m|qr", /\[/, /\]/) },
                { begin: PAIRED_RE("m|qr", /\{/, /\}/) }
              ]
            }
          ]
        },
        {
          className: "function",
          beginKeywords: "sub",
          end: "(\\s*\\(.*?\\))?[;{]",
          excludeEnd: true,
          relevance: 5,
          contains: [hljs2.TITLE_MODE]
        },
        {
          begin: "-\\w\\b",
          relevance: 0
        },
        {
          begin: "^__DATA__$",
          end: "^__END__$",
          subLanguage: "mojolicious",
          contains: [
            {
              begin: "^@@.*",
              end: "$",
              className: "comment"
            }
          ]
        }
      ];
      SUBST.contains = PERL_DEFAULT_CONTAINS;
      METHOD.contains = PERL_DEFAULT_CONTAINS;
      return {
        name: "Perl",
        aliases: [
          "pl",
          "pm"
        ],
        keywords: PERL_KEYWORDS,
        contains: PERL_DEFAULT_CONTAINS
      };
    }
    module.exports = perl2;
  }
});

// node_modules/highlight.js/lib/languages/php.js
var require_php = __commonJS({
  "node_modules/highlight.js/lib/languages/php.js"(exports, module) {
    function php2(hljs2) {
      const VARIABLE = {
        className: "variable",
        begin: `\\$+[a-zA-Z_\x7F-\xFF][a-zA-Z0-9_\x7F-\xFF]*(?![A-Za-z0-9])(?![$])`
      };
      const PREPROCESSOR = {
        className: "meta",
        variants: [
          { begin: /<\?php/, relevance: 10 },
          // boost for obvious PHP
          { begin: /<\?[=]?/ },
          { begin: /\?>/ }
          // end php tag
        ]
      };
      const SUBST = {
        className: "subst",
        variants: [
          { begin: /\$\w+/ },
          { begin: /\{\$/, end: /\}/ }
        ]
      };
      const SINGLE_QUOTED = hljs2.inherit(hljs2.APOS_STRING_MODE, {
        illegal: null
      });
      const DOUBLE_QUOTED = hljs2.inherit(hljs2.QUOTE_STRING_MODE, {
        illegal: null,
        contains: hljs2.QUOTE_STRING_MODE.contains.concat(SUBST)
      });
      const HEREDOC = hljs2.END_SAME_AS_BEGIN({
        begin: /<<<[ \t]*(\w+)\n/,
        end: /[ \t]*(\w+)\b/,
        contains: hljs2.QUOTE_STRING_MODE.contains.concat(SUBST)
      });
      const STRING = {
        className: "string",
        contains: [hljs2.BACKSLASH_ESCAPE, PREPROCESSOR],
        variants: [
          hljs2.inherit(SINGLE_QUOTED, {
            begin: "b'",
            end: "'"
          }),
          hljs2.inherit(DOUBLE_QUOTED, {
            begin: 'b"',
            end: '"'
          }),
          DOUBLE_QUOTED,
          SINGLE_QUOTED,
          HEREDOC
        ]
      };
      const NUMBER = {
        className: "number",
        variants: [
          { begin: `\\b0b[01]+(?:_[01]+)*\\b` },
          // Binary w/ underscore support
          { begin: `\\b0o[0-7]+(?:_[0-7]+)*\\b` },
          // Octals w/ underscore support
          { begin: `\\b0x[\\da-f]+(?:_[\\da-f]+)*\\b` },
          // Hex w/ underscore support
          // Decimals w/ underscore support, with optional fragments and scientific exponent (e) suffix.
          { begin: `(?:\\b\\d+(?:_\\d+)*(\\.(?:\\d+(?:_\\d+)*))?|\\B\\.\\d+)(?:e[+-]?\\d+)?` }
        ],
        relevance: 0
      };
      const KEYWORDS = {
        keyword: (
          // Magic constants:
          // <https://www.php.net/manual/en/language.constants.predefined.php>
          "__CLASS__ __DIR__ __FILE__ __FUNCTION__ __LINE__ __METHOD__ __NAMESPACE__ __TRAIT__ die echo exit include include_once print require require_once array abstract and as binary bool boolean break callable case catch class clone const continue declare default do double else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum eval extends final finally float for foreach from global goto if implements instanceof insteadof int integer interface isset iterable list match|0 mixed new object or private protected public real return string switch throw trait try unset use var void while xor yield"
        ),
        literal: "false null true",
        built_in: (
          // Standard PHP library:
          // <https://www.php.net/manual/en/book.spl.php>
          "Error|0 AppendIterator ArgumentCountError ArithmeticError ArrayIterator ArrayObject AssertionError BadFunctionCallException BadMethodCallException CachingIterator CallbackFilterIterator CompileError Countable DirectoryIterator DivisionByZeroError DomainException EmptyIterator ErrorException Exception FilesystemIterator FilterIterator GlobIterator InfiniteIterator InvalidArgumentException IteratorIterator LengthException LimitIterator LogicException MultipleIterator NoRewindIterator OutOfBoundsException OutOfRangeException OuterIterator OverflowException ParentIterator ParseError RangeException RecursiveArrayIterator RecursiveCachingIterator RecursiveCallbackFilterIterator RecursiveDirectoryIterator RecursiveFilterIterator RecursiveIterator RecursiveIteratorIterator RecursiveRegexIterator RecursiveTreeIterator RegexIterator RuntimeException SeekableIterator SplDoublyLinkedList SplFileInfo SplFileObject SplFixedArray SplHeap SplMaxHeap SplMinHeap SplObjectStorage SplObserver SplObserver SplPriorityQueue SplQueue SplStack SplSubject SplSubject SplTempFileObject TypeError UnderflowException UnexpectedValueException UnhandledMatchError ArrayAccess Closure Generator Iterator IteratorAggregate Serializable Stringable Throwable Traversable WeakReference WeakMap Directory __PHP_Incomplete_Class parent php_user_filter self static stdClass"
        )
      };
      return {
        aliases: ["php3", "php4", "php5", "php6", "php7", "php8"],
        case_insensitive: true,
        keywords: KEYWORDS,
        contains: [
          hljs2.HASH_COMMENT_MODE,
          hljs2.COMMENT("//", "$", { contains: [PREPROCESSOR] }),
          hljs2.COMMENT(
            "/\\*",
            "\\*/",
            {
              contains: [
                {
                  className: "doctag",
                  begin: "@[A-Za-z]+"
                }
              ]
            }
          ),
          hljs2.COMMENT(
            "__halt_compiler.+?;",
            false,
            {
              endsWithParent: true,
              keywords: "__halt_compiler"
            }
          ),
          PREPROCESSOR,
          {
            className: "keyword",
            begin: /\$this\b/
          },
          VARIABLE,
          {
            // swallow composed identifiers to avoid parsing them as keywords
            begin: /(::|->)+[a-zA-Z_\x7f-\xff][a-zA-Z0-9_\x7f-\xff]*/
          },
          {
            className: "function",
            relevance: 0,
            beginKeywords: "fn function",
            end: /[;{]/,
            excludeEnd: true,
            illegal: "[$%\\[]",
            contains: [
              {
                beginKeywords: "use"
              },
              hljs2.UNDERSCORE_TITLE_MODE,
              {
                begin: "=>",
                // No markup, just a relevance booster
                endsParent: true
              },
              {
                className: "params",
                begin: "\\(",
                end: "\\)",
                excludeBegin: true,
                excludeEnd: true,
                keywords: KEYWORDS,
                contains: [
                  "self",
                  VARIABLE,
                  hljs2.C_BLOCK_COMMENT_MODE,
                  STRING,
                  NUMBER
                ]
              }
            ]
          },
          {
            className: "class",
            variants: [
              { beginKeywords: "enum", illegal: /[($"]/ },
              { beginKeywords: "class interface trait", illegal: /[:($"]/ }
            ],
            relevance: 0,
            end: /\{/,
            excludeEnd: true,
            contains: [
              { beginKeywords: "extends implements" },
              hljs2.UNDERSCORE_TITLE_MODE
            ]
          },
          {
            beginKeywords: "namespace",
            relevance: 0,
            end: ";",
            illegal: /[.']/,
            contains: [hljs2.UNDERSCORE_TITLE_MODE]
          },
          {
            beginKeywords: "use",
            relevance: 0,
            end: ";",
            contains: [hljs2.UNDERSCORE_TITLE_MODE]
          },
          STRING,
          NUMBER
        ]
      };
    }
    module.exports = php2;
  }
});

// node_modules/highlight.js/lib/languages/python.js
var require_python = __commonJS({
  "node_modules/highlight.js/lib/languages/python.js"(exports, module) {
    function source(re) {
      if (!re) return null;
      if (typeof re === "string") return re;
      return re.source;
    }
    function lookahead(re) {
      return concat("(?=", re, ")");
    }
    function concat(...args) {
      const joined = args.map((x) => source(x)).join("");
      return joined;
    }
    function python2(hljs2) {
      const RESERVED_WORDS = [
        "and",
        "as",
        "assert",
        "async",
        "await",
        "break",
        "class",
        "continue",
        "def",
        "del",
        "elif",
        "else",
        "except",
        "finally",
        "for",
        "from",
        "global",
        "if",
        "import",
        "in",
        "is",
        "lambda",
        "nonlocal|10",
        "not",
        "or",
        "pass",
        "raise",
        "return",
        "try",
        "while",
        "with",
        "yield"
      ];
      const BUILT_INS = [
        "__import__",
        "abs",
        "all",
        "any",
        "ascii",
        "bin",
        "bool",
        "breakpoint",
        "bytearray",
        "bytes",
        "callable",
        "chr",
        "classmethod",
        "compile",
        "complex",
        "delattr",
        "dict",
        "dir",
        "divmod",
        "enumerate",
        "eval",
        "exec",
        "filter",
        "float",
        "format",
        "frozenset",
        "getattr",
        "globals",
        "hasattr",
        "hash",
        "help",
        "hex",
        "id",
        "input",
        "int",
        "isinstance",
        "issubclass",
        "iter",
        "len",
        "list",
        "locals",
        "map",
        "max",
        "memoryview",
        "min",
        "next",
        "object",
        "oct",
        "open",
        "ord",
        "pow",
        "print",
        "property",
        "range",
        "repr",
        "reversed",
        "round",
        "set",
        "setattr",
        "slice",
        "sorted",
        "staticmethod",
        "str",
        "sum",
        "super",
        "tuple",
        "type",
        "vars",
        "zip"
      ];
      const LITERALS = [
        "__debug__",
        "Ellipsis",
        "False",
        "None",
        "NotImplemented",
        "True"
      ];
      const TYPES = [
        "Any",
        "Callable",
        "Coroutine",
        "Dict",
        "List",
        "Literal",
        "Generic",
        "Optional",
        "Sequence",
        "Set",
        "Tuple",
        "Type",
        "Union"
      ];
      const KEYWORDS = {
        $pattern: /[A-Za-z]\w+|__\w+__/,
        keyword: RESERVED_WORDS,
        built_in: BUILT_INS,
        literal: LITERALS,
        type: TYPES
      };
      const PROMPT = {
        className: "meta",
        begin: /^(>>>|\.\.\.) /
      };
      const SUBST = {
        className: "subst",
        begin: /\{/,
        end: /\}/,
        keywords: KEYWORDS,
        illegal: /#/
      };
      const LITERAL_BRACKET = {
        begin: /\{\{/,
        relevance: 0
      };
      const STRING = {
        className: "string",
        contains: [hljs2.BACKSLASH_ESCAPE],
        variants: [
          {
            begin: /([uU]|[bB]|[rR]|[bB][rR]|[rR][bB])?'''/,
            end: /'''/,
            contains: [
              hljs2.BACKSLASH_ESCAPE,
              PROMPT
            ],
            relevance: 10
          },
          {
            begin: /([uU]|[bB]|[rR]|[bB][rR]|[rR][bB])?"""/,
            end: /"""/,
            contains: [
              hljs2.BACKSLASH_ESCAPE,
              PROMPT
            ],
            relevance: 10
          },
          {
            begin: /([fF][rR]|[rR][fF]|[fF])'''/,
            end: /'''/,
            contains: [
              hljs2.BACKSLASH_ESCAPE,
              PROMPT,
              LITERAL_BRACKET,
              SUBST
            ]
          },
          {
            begin: /([fF][rR]|[rR][fF]|[fF])"""/,
            end: /"""/,
            contains: [
              hljs2.BACKSLASH_ESCAPE,
              PROMPT,
              LITERAL_BRACKET,
              SUBST
            ]
          },
          {
            begin: /([uU]|[rR])'/,
            end: /'/,
            relevance: 10
          },
          {
            begin: /([uU]|[rR])"/,
            end: /"/,
            relevance: 10
          },
          {
            begin: /([bB]|[bB][rR]|[rR][bB])'/,
            end: /'/
          },
          {
            begin: /([bB]|[bB][rR]|[rR][bB])"/,
            end: /"/
          },
          {
            begin: /([fF][rR]|[rR][fF]|[fF])'/,
            end: /'/,
            contains: [
              hljs2.BACKSLASH_ESCAPE,
              LITERAL_BRACKET,
              SUBST
            ]
          },
          {
            begin: /([fF][rR]|[rR][fF]|[fF])"/,
            end: /"/,
            contains: [
              hljs2.BACKSLASH_ESCAPE,
              LITERAL_BRACKET,
              SUBST
            ]
          },
          hljs2.APOS_STRING_MODE,
          hljs2.QUOTE_STRING_MODE
        ]
      };
      const digitpart = "[0-9](_?[0-9])*";
      const pointfloat = `(\\b(${digitpart}))?\\.(${digitpart})|\\b(${digitpart})\\.`;
      const NUMBER = {
        className: "number",
        relevance: 0,
        variants: [
          // exponentfloat, pointfloat
          // https://docs.python.org/3.9/reference/lexical_analysis.html#floating-point-literals
          // optionally imaginary
          // https://docs.python.org/3.9/reference/lexical_analysis.html#imaginary-literals
          // Note: no leading \b because floats can start with a decimal point
          // and we don't want to mishandle e.g. `fn(.5)`,
          // no trailing \b for pointfloat because it can end with a decimal point
          // and we don't want to mishandle e.g. `0..hex()`; this should be safe
          // because both MUST contain a decimal point and so cannot be confused with
          // the interior part of an identifier
          {
            begin: `(\\b(${digitpart})|(${pointfloat}))[eE][+-]?(${digitpart})[jJ]?\\b`
          },
          {
            begin: `(${pointfloat})[jJ]?`
          },
          // decinteger, bininteger, octinteger, hexinteger
          // https://docs.python.org/3.9/reference/lexical_analysis.html#integer-literals
          // optionally "long" in Python 2
          // https://docs.python.org/2.7/reference/lexical_analysis.html#integer-and-long-integer-literals
          // decinteger is optionally imaginary
          // https://docs.python.org/3.9/reference/lexical_analysis.html#imaginary-literals
          {
            begin: "\\b([1-9](_?[0-9])*|0+(_?0)*)[lLjJ]?\\b"
          },
          {
            begin: "\\b0[bB](_?[01])+[lL]?\\b"
          },
          {
            begin: "\\b0[oO](_?[0-7])+[lL]?\\b"
          },
          {
            begin: "\\b0[xX](_?[0-9a-fA-F])+[lL]?\\b"
          },
          // imagnumber (digitpart-based)
          // https://docs.python.org/3.9/reference/lexical_analysis.html#imaginary-literals
          {
            begin: `\\b(${digitpart})[jJ]\\b`
          }
        ]
      };
      const COMMENT_TYPE = {
        className: "comment",
        begin: lookahead(/# type:/),
        end: /$/,
        keywords: KEYWORDS,
        contains: [
          {
            // prevent keywords from coloring `type`
            begin: /# type:/
          },
          // comment within a datatype comment includes no keywords
          {
            begin: /#/,
            end: /\b\B/,
            endsWithParent: true
          }
        ]
      };
      const PARAMS = {
        className: "params",
        variants: [
          // Exclude params in functions without params
          {
            className: "",
            begin: /\(\s*\)/,
            skip: true
          },
          {
            begin: /\(/,
            end: /\)/,
            excludeBegin: true,
            excludeEnd: true,
            keywords: KEYWORDS,
            contains: [
              "self",
              PROMPT,
              NUMBER,
              STRING,
              hljs2.HASH_COMMENT_MODE
            ]
          }
        ]
      };
      SUBST.contains = [
        STRING,
        NUMBER,
        PROMPT
      ];
      return {
        name: "Python",
        aliases: [
          "py",
          "gyp",
          "ipython"
        ],
        keywords: KEYWORDS,
        illegal: /(<\/|->|\?)|=>/,
        contains: [
          PROMPT,
          NUMBER,
          {
            // very common convention
            begin: /\bself\b/
          },
          {
            // eat "if" prior to string so that it won't accidentally be
            // labeled as an f-string
            beginKeywords: "if",
            relevance: 0
          },
          STRING,
          COMMENT_TYPE,
          hljs2.HASH_COMMENT_MODE,
          {
            variants: [
              {
                className: "function",
                beginKeywords: "def"
              },
              {
                className: "class",
                beginKeywords: "class"
              }
            ],
            end: /:/,
            illegal: /[${=;\n,]/,
            contains: [
              hljs2.UNDERSCORE_TITLE_MODE,
              PARAMS,
              {
                begin: /->/,
                endsWithParent: true,
                keywords: KEYWORDS
              }
            ]
          },
          {
            className: "meta",
            begin: /^[\t ]*@/,
            end: /(?=#)|$/,
            contains: [
              NUMBER,
              PARAMS,
              STRING
            ]
          }
        ]
      };
    }
    module.exports = python2;
  }
});

// node_modules/highlight.js/lib/languages/ruby.js
var require_ruby = __commonJS({
  "node_modules/highlight.js/lib/languages/ruby.js"(exports, module) {
    function source(re) {
      if (!re) return null;
      if (typeof re === "string") return re;
      return re.source;
    }
    function lookahead(re) {
      return concat("(?=", re, ")");
    }
    function concat(...args) {
      const joined = args.map((x) => source(x)).join("");
      return joined;
    }
    function ruby2(hljs2) {
      const RUBY_METHOD_RE = "([a-zA-Z_]\\w*[!?=]?|[-+~]@|<<|>>|=~|===?|<=>|[<>]=?|\\*\\*|[-/+%^&*~`|]|\\[\\]=?)";
      const RUBY_KEYWORDS = {
        keyword: "and then defined module in return redo if BEGIN retry end for self when next until do begin unless END rescue else break undef not super class case require yield alias while ensure elsif or include attr_reader attr_writer attr_accessor __FILE__",
        built_in: "proc lambda",
        literal: "true false nil"
      };
      const YARDOCTAG = {
        className: "doctag",
        begin: "@[A-Za-z]+"
      };
      const IRB_OBJECT = {
        begin: "#<",
        end: ">"
      };
      const COMMENT_MODES = [
        hljs2.COMMENT(
          "#",
          "$",
          {
            contains: [YARDOCTAG]
          }
        ),
        hljs2.COMMENT(
          "^=begin",
          "^=end",
          {
            contains: [YARDOCTAG],
            relevance: 10
          }
        ),
        hljs2.COMMENT("^__END__", "\\n$")
      ];
      const SUBST = {
        className: "subst",
        begin: /#\{/,
        end: /\}/,
        keywords: RUBY_KEYWORDS
      };
      const STRING = {
        className: "string",
        contains: [
          hljs2.BACKSLASH_ESCAPE,
          SUBST
        ],
        variants: [
          {
            begin: /'/,
            end: /'/
          },
          {
            begin: /"/,
            end: /"/
          },
          {
            begin: /`/,
            end: /`/
          },
          {
            begin: /%[qQwWx]?\(/,
            end: /\)/
          },
          {
            begin: /%[qQwWx]?\[/,
            end: /\]/
          },
          {
            begin: /%[qQwWx]?\{/,
            end: /\}/
          },
          {
            begin: /%[qQwWx]?</,
            end: />/
          },
          {
            begin: /%[qQwWx]?\//,
            end: /\//
          },
          {
            begin: /%[qQwWx]?%/,
            end: /%/
          },
          {
            begin: /%[qQwWx]?-/,
            end: /-/
          },
          {
            begin: /%[qQwWx]?\|/,
            end: /\|/
          },
          // in the following expressions, \B in the beginning suppresses recognition of ?-sequences
          // where ? is the last character of a preceding identifier, as in: `func?4`
          {
            begin: /\B\?(\\\d{1,3})/
          },
          {
            begin: /\B\?(\\x[A-Fa-f0-9]{1,2})/
          },
          {
            begin: /\B\?(\\u\{?[A-Fa-f0-9]{1,6}\}?)/
          },
          {
            begin: /\B\?(\\M-\\C-|\\M-\\c|\\c\\M-|\\M-|\\C-\\M-)[\x20-\x7e]/
          },
          {
            begin: /\B\?\\(c|C-)[\x20-\x7e]/
          },
          {
            begin: /\B\?\\?\S/
          },
          {
            // heredocs
            begin: /<<[-~]?'?(\w+)\n(?:[^\n]*\n)*?\s*\1\b/,
            returnBegin: true,
            contains: [
              {
                begin: /<<[-~]?'?/
              },
              hljs2.END_SAME_AS_BEGIN({
                begin: /(\w+)/,
                end: /(\w+)/,
                contains: [
                  hljs2.BACKSLASH_ESCAPE,
                  SUBST
                ]
              })
            ]
          }
        ]
      };
      const decimal = "[1-9](_?[0-9])*|0";
      const digits = "[0-9](_?[0-9])*";
      const NUMBER = {
        className: "number",
        relevance: 0,
        variants: [
          // decimal integer/float, optionally exponential or rational, optionally imaginary
          {
            begin: `\\b(${decimal})(\\.(${digits}))?([eE][+-]?(${digits})|r)?i?\\b`
          },
          // explicit decimal/binary/octal/hexadecimal integer,
          // optionally rational and/or imaginary
          {
            begin: "\\b0[dD][0-9](_?[0-9])*r?i?\\b"
          },
          {
            begin: "\\b0[bB][0-1](_?[0-1])*r?i?\\b"
          },
          {
            begin: "\\b0[oO][0-7](_?[0-7])*r?i?\\b"
          },
          {
            begin: "\\b0[xX][0-9a-fA-F](_?[0-9a-fA-F])*r?i?\\b"
          },
          // 0-prefixed implicit octal integer, optionally rational and/or imaginary
          {
            begin: "\\b0(_?[0-7])+r?i?\\b"
          }
        ]
      };
      const PARAMS = {
        className: "params",
        begin: "\\(",
        end: "\\)",
        endsParent: true,
        keywords: RUBY_KEYWORDS
      };
      const RUBY_DEFAULT_CONTAINS = [
        STRING,
        {
          className: "class",
          beginKeywords: "class module",
          end: "$|;",
          illegal: /=/,
          contains: [
            hljs2.inherit(hljs2.TITLE_MODE, {
              begin: "[A-Za-z_]\\w*(::\\w+)*(\\?|!)?"
            }),
            {
              begin: "<\\s*",
              contains: [
                {
                  begin: "(" + hljs2.IDENT_RE + "::)?" + hljs2.IDENT_RE,
                  // we already get points for <, we don't need poitns
                  // for the name also
                  relevance: 0
                }
              ]
            }
          ].concat(COMMENT_MODES)
        },
        {
          className: "function",
          // def method_name(
          // def method_name;
          // def method_name (end of line)
          begin: concat(/def\s+/, lookahead(RUBY_METHOD_RE + "\\s*(\\(|;|$)")),
          relevance: 0,
          // relevance comes from kewords
          keywords: "def",
          end: "$|;",
          contains: [
            hljs2.inherit(hljs2.TITLE_MODE, {
              begin: RUBY_METHOD_RE
            }),
            PARAMS
          ].concat(COMMENT_MODES)
        },
        {
          // swallow namespace qualifiers before symbols
          begin: hljs2.IDENT_RE + "::"
        },
        {
          className: "symbol",
          begin: hljs2.UNDERSCORE_IDENT_RE + "(!|\\?)?:",
          relevance: 0
        },
        {
          className: "symbol",
          begin: ":(?!\\s)",
          contains: [
            STRING,
            {
              begin: RUBY_METHOD_RE
            }
          ],
          relevance: 0
        },
        NUMBER,
        {
          // negative-look forward attemps to prevent false matches like:
          // @ident@ or $ident$ that might indicate this is not ruby at all
          className: "variable",
          begin: `(\\$\\W)|((\\$|@@?)(\\w+))(?=[^@$?])(?![A-Za-z])(?![@$?'])`
        },
        {
          className: "params",
          begin: /\|/,
          end: /\|/,
          relevance: 0,
          // this could be a lot of things (in other languages) other than params
          keywords: RUBY_KEYWORDS
        },
        {
          // regexp container
          begin: "(" + hljs2.RE_STARTERS_RE + "|unless)\\s*",
          keywords: "unless",
          contains: [
            {
              className: "regexp",
              contains: [
                hljs2.BACKSLASH_ESCAPE,
                SUBST
              ],
              illegal: /\n/,
              variants: [
                {
                  begin: "/",
                  end: "/[a-z]*"
                },
                {
                  begin: /%r\{/,
                  end: /\}[a-z]*/
                },
                {
                  begin: "%r\\(",
                  end: "\\)[a-z]*"
                },
                {
                  begin: "%r!",
                  end: "![a-z]*"
                },
                {
                  begin: "%r\\[",
                  end: "\\][a-z]*"
                }
              ]
            }
          ].concat(IRB_OBJECT, COMMENT_MODES),
          relevance: 0
        }
      ].concat(IRB_OBJECT, COMMENT_MODES);
      SUBST.contains = RUBY_DEFAULT_CONTAINS;
      PARAMS.contains = RUBY_DEFAULT_CONTAINS;
      const SIMPLE_PROMPT = "[>?]>";
      const DEFAULT_PROMPT = "[\\w#]+\\(\\w+\\):\\d+:\\d+>";
      const RVM_PROMPT = "(\\w+-)?\\d+\\.\\d+\\.\\d+(p\\d+)?[^\\d][^>]+>";
      const IRB_DEFAULT = [
        {
          begin: /^\s*=>/,
          starts: {
            end: "$",
            contains: RUBY_DEFAULT_CONTAINS
          }
        },
        {
          className: "meta",
          begin: "^(" + SIMPLE_PROMPT + "|" + DEFAULT_PROMPT + "|" + RVM_PROMPT + ")(?=[ ])",
          starts: {
            end: "$",
            contains: RUBY_DEFAULT_CONTAINS
          }
        }
      ];
      COMMENT_MODES.unshift(IRB_OBJECT);
      return {
        name: "Ruby",
        aliases: [
          "rb",
          "gemspec",
          "podspec",
          "thor",
          "irb"
        ],
        keywords: RUBY_KEYWORDS,
        illegal: /\/\*/,
        contains: [
          hljs2.SHEBANG({
            binary: "ruby"
          })
        ].concat(IRB_DEFAULT).concat(COMMENT_MODES).concat(RUBY_DEFAULT_CONTAINS)
      };
    }
    module.exports = ruby2;
  }
});

// node_modules/highlight.js/lib/languages/rust.js
var require_rust = __commonJS({
  "node_modules/highlight.js/lib/languages/rust.js"(exports, module) {
    function rust2(hljs2) {
      const NUM_SUFFIX = "([ui](8|16|32|64|128|size)|f(32|64))?";
      const KEYWORDS = "abstract as async await become box break const continue crate do dyn else enum extern false final fn for if impl in let loop macro match mod move mut override priv pub ref return self Self static struct super trait true try type typeof unsafe unsized use virtual where while yield";
      const BUILTINS = (
        // functions
        "drop i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 str char bool Box Option Result String Vec Copy Send Sized Sync Drop Fn FnMut FnOnce ToOwned Clone Debug PartialEq PartialOrd Eq Ord AsRef AsMut Into From Default Iterator Extend IntoIterator DoubleEndedIterator ExactSizeIterator SliceConcatExt ToString assert! assert_eq! bitflags! bytes! cfg! col! concat! concat_idents! debug_assert! debug_assert_eq! env! panic! file! format! format_args! include_bin! include_str! line! local_data_key! module_path! option_env! print! println! select! stringify! try! unimplemented! unreachable! vec! write! writeln! macro_rules! assert_ne! debug_assert_ne!"
      );
      return {
        name: "Rust",
        aliases: ["rs"],
        keywords: {
          $pattern: hljs2.IDENT_RE + "!?",
          keyword: KEYWORDS,
          literal: "true false Some None Ok Err",
          built_in: BUILTINS
        },
        illegal: "</",
        contains: [
          hljs2.C_LINE_COMMENT_MODE,
          hljs2.COMMENT("/\\*", "\\*/", {
            contains: ["self"]
          }),
          hljs2.inherit(hljs2.QUOTE_STRING_MODE, {
            begin: /b?"/,
            illegal: null
          }),
          {
            className: "string",
            variants: [
              {
                begin: /r(#*)"(.|\n)*?"\1(?!#)/
              },
              {
                begin: /b?'\\?(x\w{2}|u\w{4}|U\w{8}|.)'/
              }
            ]
          },
          {
            className: "symbol",
            begin: /'[a-zA-Z_][a-zA-Z0-9_]*/
          },
          {
            className: "number",
            variants: [
              {
                begin: "\\b0b([01_]+)" + NUM_SUFFIX
              },
              {
                begin: "\\b0o([0-7_]+)" + NUM_SUFFIX
              },
              {
                begin: "\\b0x([A-Fa-f0-9_]+)" + NUM_SUFFIX
              },
              {
                begin: "\\b(\\d[\\d_]*(\\.[0-9_]+)?([eE][+-]?[0-9_]+)?)" + NUM_SUFFIX
              }
            ],
            relevance: 0
          },
          {
            className: "function",
            beginKeywords: "fn",
            end: "(\\(|<)",
            excludeEnd: true,
            contains: [hljs2.UNDERSCORE_TITLE_MODE]
          },
          {
            className: "meta",
            begin: "#!?\\[",
            end: "\\]",
            contains: [
              {
                className: "meta-string",
                begin: /"/,
                end: /"/
              }
            ]
          },
          {
            className: "class",
            beginKeywords: "type",
            end: ";",
            contains: [
              hljs2.inherit(hljs2.UNDERSCORE_TITLE_MODE, {
                endsParent: true
              })
            ],
            illegal: "\\S"
          },
          {
            className: "class",
            beginKeywords: "trait enum struct union",
            end: /\{/,
            contains: [
              hljs2.inherit(hljs2.UNDERSCORE_TITLE_MODE, {
                endsParent: true
              })
            ],
            illegal: "[\\w\\d]"
          },
          {
            begin: hljs2.IDENT_RE + "::",
            keywords: {
              built_in: BUILTINS
            }
          },
          {
            begin: "->"
          }
        ]
      };
    }
    module.exports = rust2;
  }
});

// node_modules/highlight.js/lib/languages/scala.js
var require_scala = __commonJS({
  "node_modules/highlight.js/lib/languages/scala.js"(exports, module) {
    function scala2(hljs2) {
      const ANNOTATION = {
        className: "meta",
        begin: "@[A-Za-z]+"
      };
      const SUBST = {
        className: "subst",
        variants: [
          {
            begin: "\\$[A-Za-z0-9_]+"
          },
          {
            begin: /\$\{/,
            end: /\}/
          }
        ]
      };
      const STRING = {
        className: "string",
        variants: [
          {
            begin: '"""',
            end: '"""'
          },
          {
            begin: '"',
            end: '"',
            illegal: "\\n",
            contains: [hljs2.BACKSLASH_ESCAPE]
          },
          {
            begin: '[a-z]+"',
            end: '"',
            illegal: "\\n",
            contains: [
              hljs2.BACKSLASH_ESCAPE,
              SUBST
            ]
          },
          {
            className: "string",
            begin: '[a-z]+"""',
            end: '"""',
            contains: [SUBST],
            relevance: 10
          }
        ]
      };
      const SYMBOL = {
        className: "symbol",
        begin: "'\\w[\\w\\d_]*(?!')"
      };
      const TYPE = {
        className: "type",
        begin: "\\b[A-Z][A-Za-z0-9_]*",
        relevance: 0
      };
      const NAME = {
        className: "title",
        begin: /[^0-9\n\t "'(),.`{}\[\]:;][^\n\t "'(),.`{}\[\]:;]+|[^0-9\n\t "'(),.`{}\[\]:;=]/,
        relevance: 0
      };
      const CLASS = {
        className: "class",
        beginKeywords: "class object trait type",
        end: /[:={\[\n;]/,
        excludeEnd: true,
        contains: [
          hljs2.C_LINE_COMMENT_MODE,
          hljs2.C_BLOCK_COMMENT_MODE,
          {
            beginKeywords: "extends with",
            relevance: 10
          },
          {
            begin: /\[/,
            end: /\]/,
            excludeBegin: true,
            excludeEnd: true,
            relevance: 0,
            contains: [TYPE]
          },
          {
            className: "params",
            begin: /\(/,
            end: /\)/,
            excludeBegin: true,
            excludeEnd: true,
            relevance: 0,
            contains: [TYPE]
          },
          NAME
        ]
      };
      const METHOD = {
        className: "function",
        beginKeywords: "def",
        end: /[:={\[(\n;]/,
        excludeEnd: true,
        contains: [NAME]
      };
      return {
        name: "Scala",
        keywords: {
          literal: "true false null",
          keyword: "type yield lazy override def with val var sealed abstract private trait object if forSome for while throw finally protected extends import final return else break new catch super class case package default try this match continue throws implicit"
        },
        contains: [
          hljs2.C_LINE_COMMENT_MODE,
          hljs2.C_BLOCK_COMMENT_MODE,
          STRING,
          SYMBOL,
          TYPE,
          METHOD,
          CLASS,
          hljs2.C_NUMBER_MODE,
          ANNOTATION
        ]
      };
    }
    module.exports = scala2;
  }
});

// node_modules/highlight.js/lib/languages/swift.js
var require_swift = __commonJS({
  "node_modules/highlight.js/lib/languages/swift.js"(exports, module) {
    function source(re) {
      if (!re) return null;
      if (typeof re === "string") return re;
      return re.source;
    }
    function lookahead(re) {
      return concat("(?=", re, ")");
    }
    function concat(...args) {
      const joined = args.map((x) => source(x)).join("");
      return joined;
    }
    function either(...args) {
      const joined = "(" + args.map((x) => source(x)).join("|") + ")";
      return joined;
    }
    var keywordWrapper = (keyword) => concat(
      /\b/,
      keyword,
      /\w$/.test(keyword) ? /\b/ : /\B/
    );
    var dotKeywords = [
      "Protocol",
      // contextual
      "Type"
      // contextual
    ].map(keywordWrapper);
    var optionalDotKeywords = [
      "init",
      "self"
    ].map(keywordWrapper);
    var keywordTypes = [
      "Any",
      "Self"
    ];
    var keywords = [
      // strings below will be fed into the regular `keywords` engine while regex
      // will result in additional modes being created to scan for those keywords to
      // avoid conflicts with other rules
      "associatedtype",
      "async",
      "await",
      /as\?/,
      // operator
      /as!/,
      // operator
      "as",
      // operator
      "break",
      "case",
      "catch",
      "class",
      "continue",
      "convenience",
      // contextual
      "default",
      "defer",
      "deinit",
      "didSet",
      // contextual
      "do",
      "dynamic",
      // contextual
      "else",
      "enum",
      "extension",
      "fallthrough",
      /fileprivate\(set\)/,
      "fileprivate",
      "final",
      // contextual
      "for",
      "func",
      "get",
      // contextual
      "guard",
      "if",
      "import",
      "indirect",
      // contextual
      "infix",
      // contextual
      /init\?/,
      /init!/,
      "inout",
      /internal\(set\)/,
      "internal",
      "in",
      "is",
      // operator
      "lazy",
      // contextual
      "let",
      "mutating",
      // contextual
      "nonmutating",
      // contextual
      /open\(set\)/,
      // contextual
      "open",
      // contextual
      "operator",
      "optional",
      // contextual
      "override",
      // contextual
      "postfix",
      // contextual
      "precedencegroup",
      "prefix",
      // contextual
      /private\(set\)/,
      "private",
      "protocol",
      /public\(set\)/,
      "public",
      "repeat",
      "required",
      // contextual
      "rethrows",
      "return",
      "set",
      // contextual
      "some",
      // contextual
      "static",
      "struct",
      "subscript",
      "super",
      "switch",
      "throws",
      "throw",
      /try\?/,
      // operator
      /try!/,
      // operator
      "try",
      // operator
      "typealias",
      /unowned\(safe\)/,
      // contextual
      /unowned\(unsafe\)/,
      // contextual
      "unowned",
      // contextual
      "var",
      "weak",
      // contextual
      "where",
      "while",
      "willSet"
      // contextual
    ];
    var literals = [
      "false",
      "nil",
      "true"
    ];
    var precedencegroupKeywords = [
      "assignment",
      "associativity",
      "higherThan",
      "left",
      "lowerThan",
      "none",
      "right"
    ];
    var numberSignKeywords = [
      "#colorLiteral",
      "#column",
      "#dsohandle",
      "#else",
      "#elseif",
      "#endif",
      "#error",
      "#file",
      "#fileID",
      "#fileLiteral",
      "#filePath",
      "#function",
      "#if",
      "#imageLiteral",
      "#keyPath",
      "#line",
      "#selector",
      "#sourceLocation",
      "#warn_unqualified_access",
      "#warning"
    ];
    var builtIns = [
      "abs",
      "all",
      "any",
      "assert",
      "assertionFailure",
      "debugPrint",
      "dump",
      "fatalError",
      "getVaList",
      "isKnownUniquelyReferenced",
      "max",
      "min",
      "numericCast",
      "pointwiseMax",
      "pointwiseMin",
      "precondition",
      "preconditionFailure",
      "print",
      "readLine",
      "repeatElement",
      "sequence",
      "stride",
      "swap",
      "swift_unboxFromSwiftValueWithType",
      "transcode",
      "type",
      "unsafeBitCast",
      "unsafeDowncast",
      "withExtendedLifetime",
      "withUnsafeMutablePointer",
      "withUnsafePointer",
      "withVaList",
      "withoutActuallyEscaping",
      "zip"
    ];
    var operatorHead = either(
      /[/=\-+!*%<>&|^~?]/,
      /[\u00A1-\u00A7]/,
      /[\u00A9\u00AB]/,
      /[\u00AC\u00AE]/,
      /[\u00B0\u00B1]/,
      /[\u00B6\u00BB\u00BF\u00D7\u00F7]/,
      /[\u2016-\u2017]/,
      /[\u2020-\u2027]/,
      /[\u2030-\u203E]/,
      /[\u2041-\u2053]/,
      /[\u2055-\u205E]/,
      /[\u2190-\u23FF]/,
      /[\u2500-\u2775]/,
      /[\u2794-\u2BFF]/,
      /[\u2E00-\u2E7F]/,
      /[\u3001-\u3003]/,
      /[\u3008-\u3020]/,
      /[\u3030]/
    );
    var operatorCharacter = either(
      operatorHead,
      /[\u0300-\u036F]/,
      /[\u1DC0-\u1DFF]/,
      /[\u20D0-\u20FF]/,
      /[\uFE00-\uFE0F]/,
      /[\uFE20-\uFE2F]/
      // TODO: The following characters are also allowed, but the regex isn't supported yet.
      // /[\u{E0100}-\u{E01EF}]/u
    );
    var operator = concat(operatorHead, operatorCharacter, "*");
    var identifierHead = either(
      /[a-zA-Z_]/,
      /[\u00A8\u00AA\u00AD\u00AF\u00B2-\u00B5\u00B7-\u00BA]/,
      /[\u00BC-\u00BE\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF]/,
      /[\u0100-\u02FF\u0370-\u167F\u1681-\u180D\u180F-\u1DBF]/,
      /[\u1E00-\u1FFF]/,
      /[\u200B-\u200D\u202A-\u202E\u203F-\u2040\u2054\u2060-\u206F]/,
      /[\u2070-\u20CF\u2100-\u218F\u2460-\u24FF\u2776-\u2793]/,
      /[\u2C00-\u2DFF\u2E80-\u2FFF]/,
      /[\u3004-\u3007\u3021-\u302F\u3031-\u303F\u3040-\uD7FF]/,
      /[\uF900-\uFD3D\uFD40-\uFDCF\uFDF0-\uFE1F\uFE30-\uFE44]/,
      /[\uFE47-\uFEFE\uFF00-\uFFFD]/
      // Should be /[\uFE47-\uFFFD]/, but we have to exclude FEFF.
      // The following characters are also allowed, but the regexes aren't supported yet.
      // /[\u{10000}-\u{1FFFD}\u{20000-\u{2FFFD}\u{30000}-\u{3FFFD}\u{40000}-\u{4FFFD}]/u,
      // /[\u{50000}-\u{5FFFD}\u{60000-\u{6FFFD}\u{70000}-\u{7FFFD}\u{80000}-\u{8FFFD}]/u,
      // /[\u{90000}-\u{9FFFD}\u{A0000-\u{AFFFD}\u{B0000}-\u{BFFFD}\u{C0000}-\u{CFFFD}]/u,
      // /[\u{D0000}-\u{DFFFD}\u{E0000-\u{EFFFD}]/u
    );
    var identifierCharacter = either(
      identifierHead,
      /\d/,
      /[\u0300-\u036F\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/
    );
    var identifier = concat(identifierHead, identifierCharacter, "*");
    var typeIdentifier = concat(/[A-Z]/, identifierCharacter, "*");
    var keywordAttributes = [
      "autoclosure",
      concat(/convention\(/, either("swift", "block", "c"), /\)/),
      "discardableResult",
      "dynamicCallable",
      "dynamicMemberLookup",
      "escaping",
      "frozen",
      "GKInspectable",
      "IBAction",
      "IBDesignable",
      "IBInspectable",
      "IBOutlet",
      "IBSegueAction",
      "inlinable",
      "main",
      "nonobjc",
      "NSApplicationMain",
      "NSCopying",
      "NSManaged",
      concat(/objc\(/, identifier, /\)/),
      "objc",
      "objcMembers",
      "propertyWrapper",
      "requires_stored_property_inits",
      "testable",
      "UIApplicationMain",
      "unknown",
      "usableFromInline"
    ];
    var availabilityKeywords = [
      "iOS",
      "iOSApplicationExtension",
      "macOS",
      "macOSApplicationExtension",
      "macCatalyst",
      "macCatalystApplicationExtension",
      "watchOS",
      "watchOSApplicationExtension",
      "tvOS",
      "tvOSApplicationExtension",
      "swift"
    ];
    function swift2(hljs2) {
      const WHITESPACE = {
        match: /\s+/,
        relevance: 0
      };
      const BLOCK_COMMENT = hljs2.COMMENT(
        "/\\*",
        "\\*/",
        {
          contains: ["self"]
        }
      );
      const COMMENTS = [
        hljs2.C_LINE_COMMENT_MODE,
        BLOCK_COMMENT
      ];
      const DOT_KEYWORD = {
        className: "keyword",
        begin: concat(/\./, lookahead(either(...dotKeywords, ...optionalDotKeywords))),
        end: either(...dotKeywords, ...optionalDotKeywords),
        excludeBegin: true
      };
      const KEYWORD_GUARD = {
        // Consume .keyword to prevent highlighting properties and methods as keywords.
        match: concat(/\./, either(...keywords)),
        relevance: 0
      };
      const PLAIN_KEYWORDS = keywords.filter((kw) => typeof kw === "string").concat(["_|0"]);
      const REGEX_KEYWORDS = keywords.filter((kw) => typeof kw !== "string").concat(keywordTypes).map(keywordWrapper);
      const KEYWORD = {
        variants: [
          {
            className: "keyword",
            match: either(...REGEX_KEYWORDS, ...optionalDotKeywords)
          }
        ]
      };
      const KEYWORDS = {
        $pattern: either(
          /\b\w+/,
          // regular keywords
          /#\w+/
          // number keywords
        ),
        keyword: PLAIN_KEYWORDS.concat(numberSignKeywords),
        literal: literals
      };
      const KEYWORD_MODES = [
        DOT_KEYWORD,
        KEYWORD_GUARD,
        KEYWORD
      ];
      const BUILT_IN_GUARD = {
        // Consume .built_in to prevent highlighting properties and methods.
        match: concat(/\./, either(...builtIns)),
        relevance: 0
      };
      const BUILT_IN = {
        className: "built_in",
        match: concat(/\b/, either(...builtIns), /(?=\()/)
      };
      const BUILT_INS = [
        BUILT_IN_GUARD,
        BUILT_IN
      ];
      const OPERATOR_GUARD = {
        // Prevent -> from being highlighting as an operator.
        match: /->/,
        relevance: 0
      };
      const OPERATOR = {
        className: "operator",
        relevance: 0,
        variants: [
          {
            match: operator
          },
          {
            // dot-operator: only operators that start with a dot are allowed to use dots as
            // characters (..., ...<, .*, etc). So there rule here is: a dot followed by one or more
            // characters that may also include dots.
            match: `\\.(\\.|${operatorCharacter})+`
          }
        ]
      };
      const OPERATORS = [
        OPERATOR_GUARD,
        OPERATOR
      ];
      const decimalDigits = "([0-9]_*)+";
      const hexDigits = "([0-9a-fA-F]_*)+";
      const NUMBER = {
        className: "number",
        relevance: 0,
        variants: [
          // decimal floating-point-literal (subsumes decimal-literal)
          {
            match: `\\b(${decimalDigits})(\\.(${decimalDigits}))?([eE][+-]?(${decimalDigits}))?\\b`
          },
          // hexadecimal floating-point-literal (subsumes hexadecimal-literal)
          {
            match: `\\b0x(${hexDigits})(\\.(${hexDigits}))?([pP][+-]?(${decimalDigits}))?\\b`
          },
          // octal-literal
          {
            match: /\b0o([0-7]_*)+\b/
          },
          // binary-literal
          {
            match: /\b0b([01]_*)+\b/
          }
        ]
      };
      const ESCAPED_CHARACTER = (rawDelimiter = "") => ({
        className: "subst",
        variants: [
          {
            match: concat(/\\/, rawDelimiter, /[0\\tnr"']/)
          },
          {
            match: concat(/\\/, rawDelimiter, /u\{[0-9a-fA-F]{1,8}\}/)
          }
        ]
      });
      const ESCAPED_NEWLINE = (rawDelimiter = "") => ({
        className: "subst",
        match: concat(/\\/, rawDelimiter, /[\t ]*(?:[\r\n]|\r\n)/)
      });
      const INTERPOLATION = (rawDelimiter = "") => ({
        className: "subst",
        label: "interpol",
        begin: concat(/\\/, rawDelimiter, /\(/),
        end: /\)/
      });
      const MULTILINE_STRING = (rawDelimiter = "") => ({
        begin: concat(rawDelimiter, /"""/),
        end: concat(/"""/, rawDelimiter),
        contains: [
          ESCAPED_CHARACTER(rawDelimiter),
          ESCAPED_NEWLINE(rawDelimiter),
          INTERPOLATION(rawDelimiter)
        ]
      });
      const SINGLE_LINE_STRING = (rawDelimiter = "") => ({
        begin: concat(rawDelimiter, /"/),
        end: concat(/"/, rawDelimiter),
        contains: [
          ESCAPED_CHARACTER(rawDelimiter),
          INTERPOLATION(rawDelimiter)
        ]
      });
      const STRING = {
        className: "string",
        variants: [
          MULTILINE_STRING(),
          MULTILINE_STRING("#"),
          MULTILINE_STRING("##"),
          MULTILINE_STRING("###"),
          SINGLE_LINE_STRING(),
          SINGLE_LINE_STRING("#"),
          SINGLE_LINE_STRING("##"),
          SINGLE_LINE_STRING("###")
        ]
      };
      const QUOTED_IDENTIFIER = {
        match: concat(/`/, identifier, /`/)
      };
      const IMPLICIT_PARAMETER = {
        className: "variable",
        match: /\$\d+/
      };
      const PROPERTY_WRAPPER_PROJECTION = {
        className: "variable",
        match: `\\$${identifierCharacter}+`
      };
      const IDENTIFIERS = [
        QUOTED_IDENTIFIER,
        IMPLICIT_PARAMETER,
        PROPERTY_WRAPPER_PROJECTION
      ];
      const AVAILABLE_ATTRIBUTE = {
        match: /(@|#)available/,
        className: "keyword",
        starts: {
          contains: [
            {
              begin: /\(/,
              end: /\)/,
              keywords: availabilityKeywords,
              contains: [
                ...OPERATORS,
                NUMBER,
                STRING
              ]
            }
          ]
        }
      };
      const KEYWORD_ATTRIBUTE = {
        className: "keyword",
        match: concat(/@/, either(...keywordAttributes))
      };
      const USER_DEFINED_ATTRIBUTE = {
        className: "meta",
        match: concat(/@/, identifier)
      };
      const ATTRIBUTES = [
        AVAILABLE_ATTRIBUTE,
        KEYWORD_ATTRIBUTE,
        USER_DEFINED_ATTRIBUTE
      ];
      const TYPE = {
        match: lookahead(/\b[A-Z]/),
        relevance: 0,
        contains: [
          {
            // Common Apple frameworks, for relevance boost
            className: "type",
            match: concat(/(AV|CA|CF|CG|CI|CL|CM|CN|CT|MK|MP|MTK|MTL|NS|SCN|SK|UI|WK|XC)/, identifierCharacter, "+")
          },
          {
            // Type identifier
            className: "type",
            match: typeIdentifier,
            relevance: 0
          },
          {
            // Optional type
            match: /[?!]+/,
            relevance: 0
          },
          {
            // Variadic parameter
            match: /\.\.\./,
            relevance: 0
          },
          {
            // Protocol composition
            match: concat(/\s+&\s+/, lookahead(typeIdentifier)),
            relevance: 0
          }
        ]
      };
      const GENERIC_ARGUMENTS = {
        begin: /</,
        end: />/,
        keywords: KEYWORDS,
        contains: [
          ...COMMENTS,
          ...KEYWORD_MODES,
          ...ATTRIBUTES,
          OPERATOR_GUARD,
          TYPE
        ]
      };
      TYPE.contains.push(GENERIC_ARGUMENTS);
      const TUPLE_ELEMENT_NAME = {
        match: concat(identifier, /\s*:/),
        keywords: "_|0",
        relevance: 0
      };
      const TUPLE = {
        begin: /\(/,
        end: /\)/,
        relevance: 0,
        keywords: KEYWORDS,
        contains: [
          "self",
          TUPLE_ELEMENT_NAME,
          ...COMMENTS,
          ...KEYWORD_MODES,
          ...BUILT_INS,
          ...OPERATORS,
          NUMBER,
          STRING,
          ...IDENTIFIERS,
          ...ATTRIBUTES,
          TYPE
        ]
      };
      const FUNC_PLUS_TITLE = {
        beginKeywords: "func",
        contains: [
          {
            className: "title",
            match: either(QUOTED_IDENTIFIER.match, identifier, operator),
            // Required to make sure the opening < of the generic parameter clause
            // isn't parsed as a second title.
            endsParent: true,
            relevance: 0
          },
          WHITESPACE
        ]
      };
      const GENERIC_PARAMETERS = {
        begin: /</,
        end: />/,
        contains: [
          ...COMMENTS,
          TYPE
        ]
      };
      const FUNCTION_PARAMETER_NAME = {
        begin: either(
          lookahead(concat(identifier, /\s*:/)),
          lookahead(concat(identifier, /\s+/, identifier, /\s*:/))
        ),
        end: /:/,
        relevance: 0,
        contains: [
          {
            className: "keyword",
            match: /\b_\b/
          },
          {
            className: "params",
            match: identifier
          }
        ]
      };
      const FUNCTION_PARAMETERS = {
        begin: /\(/,
        end: /\)/,
        keywords: KEYWORDS,
        contains: [
          FUNCTION_PARAMETER_NAME,
          ...COMMENTS,
          ...KEYWORD_MODES,
          ...OPERATORS,
          NUMBER,
          STRING,
          ...ATTRIBUTES,
          TYPE,
          TUPLE
        ],
        endsParent: true,
        illegal: /["']/
      };
      const FUNCTION = {
        className: "function",
        match: lookahead(/\bfunc\b/),
        contains: [
          FUNC_PLUS_TITLE,
          GENERIC_PARAMETERS,
          FUNCTION_PARAMETERS,
          WHITESPACE
        ],
        illegal: [
          /\[/,
          /%/
        ]
      };
      const INIT_SUBSCRIPT = {
        className: "function",
        match: /\b(subscript|init[?!]?)\s*(?=[<(])/,
        keywords: {
          keyword: "subscript init init? init!",
          $pattern: /\w+[?!]?/
        },
        contains: [
          GENERIC_PARAMETERS,
          FUNCTION_PARAMETERS,
          WHITESPACE
        ],
        illegal: /\[|%/
      };
      const OPERATOR_DECLARATION = {
        beginKeywords: "operator",
        end: hljs2.MATCH_NOTHING_RE,
        contains: [
          {
            className: "title",
            match: operator,
            endsParent: true,
            relevance: 0
          }
        ]
      };
      const PRECEDENCEGROUP = {
        beginKeywords: "precedencegroup",
        end: hljs2.MATCH_NOTHING_RE,
        contains: [
          {
            className: "title",
            match: typeIdentifier,
            relevance: 0
          },
          {
            begin: /{/,
            end: /}/,
            relevance: 0,
            endsParent: true,
            keywords: [
              ...precedencegroupKeywords,
              ...literals
            ],
            contains: [TYPE]
          }
        ]
      };
      for (const variant of STRING.variants) {
        const interpolation = variant.contains.find((mode) => mode.label === "interpol");
        interpolation.keywords = KEYWORDS;
        const submodes = [
          ...KEYWORD_MODES,
          ...BUILT_INS,
          ...OPERATORS,
          NUMBER,
          STRING,
          ...IDENTIFIERS
        ];
        interpolation.contains = [
          ...submodes,
          {
            begin: /\(/,
            end: /\)/,
            contains: [
              "self",
              ...submodes
            ]
          }
        ];
      }
      return {
        name: "Swift",
        keywords: KEYWORDS,
        contains: [
          ...COMMENTS,
          FUNCTION,
          INIT_SUBSCRIPT,
          {
            className: "class",
            beginKeywords: "struct protocol class extension enum",
            end: "\\{",
            excludeEnd: true,
            keywords: KEYWORDS,
            contains: [
              hljs2.inherit(hljs2.TITLE_MODE, {
                begin: /[A-Za-z$_][\u00C0-\u02B80-9A-Za-z$_]*/
              }),
              ...KEYWORD_MODES
            ]
          },
          OPERATOR_DECLARATION,
          PRECEDENCEGROUP,
          {
            beginKeywords: "import",
            end: /$/,
            contains: [...COMMENTS],
            relevance: 0
          },
          ...KEYWORD_MODES,
          ...BUILT_INS,
          ...OPERATORS,
          NUMBER,
          STRING,
          ...IDENTIFIERS,
          ...ATTRIBUTES,
          TYPE,
          TUPLE
        ]
      };
    }
    module.exports = swift2;
  }
});

// node_modules/highlight.js/lib/languages/typescript.js
var require_typescript = __commonJS({
  "node_modules/highlight.js/lib/languages/typescript.js"(exports, module) {
    var IDENT_RE = "[A-Za-z$_][0-9A-Za-z$_]*";
    var KEYWORDS = [
      "as",
      // for exports
      "in",
      "of",
      "if",
      "for",
      "while",
      "finally",
      "var",
      "new",
      "function",
      "do",
      "return",
      "void",
      "else",
      "break",
      "catch",
      "instanceof",
      "with",
      "throw",
      "case",
      "default",
      "try",
      "switch",
      "continue",
      "typeof",
      "delete",
      "let",
      "yield",
      "const",
      "class",
      // JS handles these with a special rule
      // "get",
      // "set",
      "debugger",
      "async",
      "await",
      "static",
      "import",
      "from",
      "export",
      "extends"
    ];
    var LITERALS = [
      "true",
      "false",
      "null",
      "undefined",
      "NaN",
      "Infinity"
    ];
    var TYPES = [
      "Intl",
      "DataView",
      "Number",
      "Math",
      "Date",
      "String",
      "RegExp",
      "Object",
      "Function",
      "Boolean",
      "Error",
      "Symbol",
      "Set",
      "Map",
      "WeakSet",
      "WeakMap",
      "Proxy",
      "Reflect",
      "JSON",
      "Promise",
      "Float64Array",
      "Int16Array",
      "Int32Array",
      "Int8Array",
      "Uint16Array",
      "Uint32Array",
      "Float32Array",
      "Array",
      "Uint8Array",
      "Uint8ClampedArray",
      "ArrayBuffer",
      "BigInt64Array",
      "BigUint64Array",
      "BigInt"
    ];
    var ERROR_TYPES = [
      "EvalError",
      "InternalError",
      "RangeError",
      "ReferenceError",
      "SyntaxError",
      "TypeError",
      "URIError"
    ];
    var BUILT_IN_GLOBALS = [
      "setInterval",
      "setTimeout",
      "clearInterval",
      "clearTimeout",
      "require",
      "exports",
      "eval",
      "isFinite",
      "isNaN",
      "parseFloat",
      "parseInt",
      "decodeURI",
      "decodeURIComponent",
      "encodeURI",
      "encodeURIComponent",
      "escape",
      "unescape"
    ];
    var BUILT_IN_VARIABLES = [
      "arguments",
      "this",
      "super",
      "console",
      "window",
      "document",
      "localStorage",
      "module",
      "global"
      // Node.js
    ];
    var BUILT_INS = [].concat(
      BUILT_IN_GLOBALS,
      BUILT_IN_VARIABLES,
      TYPES,
      ERROR_TYPES
    );
    function source(re) {
      if (!re) return null;
      if (typeof re === "string") return re;
      return re.source;
    }
    function lookahead(re) {
      return concat("(?=", re, ")");
    }
    function concat(...args) {
      const joined = args.map((x) => source(x)).join("");
      return joined;
    }
    function javascript2(hljs2) {
      const hasClosingTag = (match, { after }) => {
        const tag = "</" + match[0].slice(1);
        const pos = match.input.indexOf(tag, after);
        return pos !== -1;
      };
      const IDENT_RE$1 = IDENT_RE;
      const FRAGMENT = {
        begin: "<>",
        end: "</>"
      };
      const XML_TAG = {
        begin: /<[A-Za-z0-9\\._:-]+/,
        end: /\/[A-Za-z0-9\\._:-]+>|\/>/,
        /**
         * @param {RegExpMatchArray} match
         * @param {CallbackResponse} response
         */
        isTrulyOpeningTag: (match, response) => {
          const afterMatchIndex = match[0].length + match.index;
          const nextChar = match.input[afterMatchIndex];
          if (nextChar === "<") {
            response.ignoreMatch();
            return;
          }
          if (nextChar === ">") {
            if (!hasClosingTag(match, { after: afterMatchIndex })) {
              response.ignoreMatch();
            }
          }
        }
      };
      const KEYWORDS$1 = {
        $pattern: IDENT_RE,
        keyword: KEYWORDS,
        literal: LITERALS,
        built_in: BUILT_INS
      };
      const decimalDigits = "[0-9](_?[0-9])*";
      const frac = `\\.(${decimalDigits})`;
      const decimalInteger = `0|[1-9](_?[0-9])*|0[0-7]*[89][0-9]*`;
      const NUMBER = {
        className: "number",
        variants: [
          // DecimalLiteral
          { begin: `(\\b(${decimalInteger})((${frac})|\\.)?|(${frac}))[eE][+-]?(${decimalDigits})\\b` },
          { begin: `\\b(${decimalInteger})\\b((${frac})\\b|\\.)?|(${frac})\\b` },
          // DecimalBigIntegerLiteral
          { begin: `\\b(0|[1-9](_?[0-9])*)n\\b` },
          // NonDecimalIntegerLiteral
          { begin: "\\b0[xX][0-9a-fA-F](_?[0-9a-fA-F])*n?\\b" },
          { begin: "\\b0[bB][0-1](_?[0-1])*n?\\b" },
          { begin: "\\b0[oO][0-7](_?[0-7])*n?\\b" },
          // LegacyOctalIntegerLiteral (does not include underscore separators)
          // https://tc39.es/ecma262/#sec-additional-syntax-numeric-literals
          { begin: "\\b0[0-7]+n?\\b" }
        ],
        relevance: 0
      };
      const SUBST = {
        className: "subst",
        begin: "\\$\\{",
        end: "\\}",
        keywords: KEYWORDS$1,
        contains: []
        // defined later
      };
      const HTML_TEMPLATE = {
        begin: "html`",
        end: "",
        starts: {
          end: "`",
          returnEnd: false,
          contains: [
            hljs2.BACKSLASH_ESCAPE,
            SUBST
          ],
          subLanguage: "xml"
        }
      };
      const CSS_TEMPLATE = {
        begin: "css`",
        end: "",
        starts: {
          end: "`",
          returnEnd: false,
          contains: [
            hljs2.BACKSLASH_ESCAPE,
            SUBST
          ],
          subLanguage: "css"
        }
      };
      const TEMPLATE_STRING = {
        className: "string",
        begin: "`",
        end: "`",
        contains: [
          hljs2.BACKSLASH_ESCAPE,
          SUBST
        ]
      };
      const JSDOC_COMMENT = hljs2.COMMENT(
        /\/\*\*(?!\/)/,
        "\\*/",
        {
          relevance: 0,
          contains: [
            {
              className: "doctag",
              begin: "@[A-Za-z]+",
              contains: [
                {
                  className: "type",
                  begin: "\\{",
                  end: "\\}",
                  relevance: 0
                },
                {
                  className: "variable",
                  begin: IDENT_RE$1 + "(?=\\s*(-)|$)",
                  endsParent: true,
                  relevance: 0
                },
                // eat spaces (not newlines) so we can find
                // types or variables
                {
                  begin: /(?=[^\n])\s/,
                  relevance: 0
                }
              ]
            }
          ]
        }
      );
      const COMMENT = {
        className: "comment",
        variants: [
          JSDOC_COMMENT,
          hljs2.C_BLOCK_COMMENT_MODE,
          hljs2.C_LINE_COMMENT_MODE
        ]
      };
      const SUBST_INTERNALS = [
        hljs2.APOS_STRING_MODE,
        hljs2.QUOTE_STRING_MODE,
        HTML_TEMPLATE,
        CSS_TEMPLATE,
        TEMPLATE_STRING,
        NUMBER,
        hljs2.REGEXP_MODE
      ];
      SUBST.contains = SUBST_INTERNALS.concat({
        // we need to pair up {} inside our subst to prevent
        // it from ending too early by matching another }
        begin: /\{/,
        end: /\}/,
        keywords: KEYWORDS$1,
        contains: [
          "self"
        ].concat(SUBST_INTERNALS)
      });
      const SUBST_AND_COMMENTS = [].concat(COMMENT, SUBST.contains);
      const PARAMS_CONTAINS = SUBST_AND_COMMENTS.concat([
        // eat recursive parens in sub expressions
        {
          begin: /\(/,
          end: /\)/,
          keywords: KEYWORDS$1,
          contains: ["self"].concat(SUBST_AND_COMMENTS)
        }
      ]);
      const PARAMS = {
        className: "params",
        begin: /\(/,
        end: /\)/,
        excludeBegin: true,
        excludeEnd: true,
        keywords: KEYWORDS$1,
        contains: PARAMS_CONTAINS
      };
      return {
        name: "Javascript",
        aliases: ["js", "jsx", "mjs", "cjs"],
        keywords: KEYWORDS$1,
        // this will be extended by TypeScript
        exports: { PARAMS_CONTAINS },
        illegal: /#(?![$_A-z])/,
        contains: [
          hljs2.SHEBANG({
            label: "shebang",
            binary: "node",
            relevance: 5
          }),
          {
            label: "use_strict",
            className: "meta",
            relevance: 10,
            begin: /^\s*['"]use (strict|asm)['"]/
          },
          hljs2.APOS_STRING_MODE,
          hljs2.QUOTE_STRING_MODE,
          HTML_TEMPLATE,
          CSS_TEMPLATE,
          TEMPLATE_STRING,
          COMMENT,
          NUMBER,
          {
            // object attr container
            begin: concat(
              /[{,\n]\s*/,
              // we need to look ahead to make sure that we actually have an
              // attribute coming up so we don't steal a comma from a potential
              // "value" container
              //
              // NOTE: this might not work how you think.  We don't actually always
              // enter this mode and stay.  Instead it might merely match `,
              // <comments up next>` and then immediately end after the , because it
              // fails to find any actual attrs. But this still does the job because
              // it prevents the value contain rule from grabbing this instead and
              // prevening this rule from firing when we actually DO have keys.
              lookahead(concat(
                // we also need to allow for multiple possible comments inbetween
                // the first key:value pairing
                /(((\/\/.*$)|(\/\*(\*[^/]|[^*])*\*\/))\s*)*/,
                IDENT_RE$1 + "\\s*:"
              ))
            ),
            relevance: 0,
            contains: [
              {
                className: "attr",
                begin: IDENT_RE$1 + lookahead("\\s*:"),
                relevance: 0
              }
            ]
          },
          {
            // "value" container
            begin: "(" + hljs2.RE_STARTERS_RE + "|\\b(case|return|throw)\\b)\\s*",
            keywords: "return throw case",
            contains: [
              COMMENT,
              hljs2.REGEXP_MODE,
              {
                className: "function",
                // we have to count the parens to make sure we actually have the
                // correct bounding ( ) before the =>.  There could be any number of
                // sub-expressions inside also surrounded by parens.
                begin: "(\\([^()]*(\\([^()]*(\\([^()]*\\)[^()]*)*\\)[^()]*)*\\)|" + hljs2.UNDERSCORE_IDENT_RE + ")\\s*=>",
                returnBegin: true,
                end: "\\s*=>",
                contains: [
                  {
                    className: "params",
                    variants: [
                      {
                        begin: hljs2.UNDERSCORE_IDENT_RE,
                        relevance: 0
                      },
                      {
                        className: null,
                        begin: /\(\s*\)/,
                        skip: true
                      },
                      {
                        begin: /\(/,
                        end: /\)/,
                        excludeBegin: true,
                        excludeEnd: true,
                        keywords: KEYWORDS$1,
                        contains: PARAMS_CONTAINS
                      }
                    ]
                  }
                ]
              },
              {
                // could be a comma delimited list of params to a function call
                begin: /,/,
                relevance: 0
              },
              {
                className: "",
                begin: /\s/,
                end: /\s*/,
                skip: true
              },
              {
                // JSX
                variants: [
                  { begin: FRAGMENT.begin, end: FRAGMENT.end },
                  {
                    begin: XML_TAG.begin,
                    // we carefully check the opening tag to see if it truly
                    // is a tag and not a false positive
                    "on:begin": XML_TAG.isTrulyOpeningTag,
                    end: XML_TAG.end
                  }
                ],
                subLanguage: "xml",
                contains: [
                  {
                    begin: XML_TAG.begin,
                    end: XML_TAG.end,
                    skip: true,
                    contains: ["self"]
                  }
                ]
              }
            ],
            relevance: 0
          },
          {
            className: "function",
            beginKeywords: "function",
            end: /[{;]/,
            excludeEnd: true,
            keywords: KEYWORDS$1,
            contains: [
              "self",
              hljs2.inherit(hljs2.TITLE_MODE, { begin: IDENT_RE$1 }),
              PARAMS
            ],
            illegal: /%/
          },
          {
            // prevent this from getting swallowed up by function
            // since they appear "function like"
            beginKeywords: "while if switch catch for"
          },
          {
            className: "function",
            // we have to count the parens to make sure we actually have the correct
            // bounding ( ).  There could be any number of sub-expressions inside
            // also surrounded by parens.
            begin: hljs2.UNDERSCORE_IDENT_RE + "\\([^()]*(\\([^()]*(\\([^()]*\\)[^()]*)*\\)[^()]*)*\\)\\s*\\{",
            // end parens
            returnBegin: true,
            contains: [
              PARAMS,
              hljs2.inherit(hljs2.TITLE_MODE, { begin: IDENT_RE$1 })
            ]
          },
          // hack: prevents detection of keywords in some circumstances
          // .keyword()
          // $keyword = x
          {
            variants: [
              { begin: "\\." + IDENT_RE$1 },
              { begin: "\\$" + IDENT_RE$1 }
            ],
            relevance: 0
          },
          {
            // ES6 class
            className: "class",
            beginKeywords: "class",
            end: /[{;=]/,
            excludeEnd: true,
            illegal: /[:"[\]]/,
            contains: [
              { beginKeywords: "extends" },
              hljs2.UNDERSCORE_TITLE_MODE
            ]
          },
          {
            begin: /\b(?=constructor)/,
            end: /[{;]/,
            excludeEnd: true,
            contains: [
              hljs2.inherit(hljs2.TITLE_MODE, { begin: IDENT_RE$1 }),
              "self",
              PARAMS
            ]
          },
          {
            begin: "(get|set)\\s+(?=" + IDENT_RE$1 + "\\()",
            end: /\{/,
            keywords: "get set",
            contains: [
              hljs2.inherit(hljs2.TITLE_MODE, { begin: IDENT_RE$1 }),
              { begin: /\(\)/ },
              // eat to avoid empty params
              PARAMS
            ]
          },
          {
            begin: /\$[(.]/
            // relevance booster for a pattern common to JS libs: `$(something)` and `$.something`
          }
        ]
      };
    }
    function typescript2(hljs2) {
      const IDENT_RE$1 = IDENT_RE;
      const NAMESPACE = {
        beginKeywords: "namespace",
        end: /\{/,
        excludeEnd: true
      };
      const INTERFACE = {
        beginKeywords: "interface",
        end: /\{/,
        excludeEnd: true,
        keywords: "interface extends"
      };
      const USE_STRICT = {
        className: "meta",
        relevance: 10,
        begin: /^\s*['"]use strict['"]/
      };
      const TYPES2 = [
        "any",
        "void",
        "number",
        "boolean",
        "string",
        "object",
        "never",
        "enum"
      ];
      const TS_SPECIFIC_KEYWORDS = [
        "type",
        "namespace",
        "typedef",
        "interface",
        "public",
        "private",
        "protected",
        "implements",
        "declare",
        "abstract",
        "readonly"
      ];
      const KEYWORDS$1 = {
        $pattern: IDENT_RE,
        keyword: KEYWORDS.concat(TS_SPECIFIC_KEYWORDS),
        literal: LITERALS,
        built_in: BUILT_INS.concat(TYPES2)
      };
      const DECORATOR = {
        className: "meta",
        begin: "@" + IDENT_RE$1
      };
      const swapMode = (mode, label, replacement) => {
        const indx = mode.contains.findIndex((m) => m.label === label);
        if (indx === -1) {
          throw new Error("can not find mode to replace");
        }
        mode.contains.splice(indx, 1, replacement);
      };
      const tsLanguage = javascript2(hljs2);
      Object.assign(tsLanguage.keywords, KEYWORDS$1);
      tsLanguage.exports.PARAMS_CONTAINS.push(DECORATOR);
      tsLanguage.contains = tsLanguage.contains.concat([
        DECORATOR,
        NAMESPACE,
        INTERFACE
      ]);
      swapMode(tsLanguage, "shebang", hljs2.SHEBANG());
      swapMode(tsLanguage, "use_strict", USE_STRICT);
      const functionDeclaration = tsLanguage.contains.find((m) => m.className === "function");
      functionDeclaration.relevance = 0;
      Object.assign(tsLanguage, {
        name: "TypeScript",
        aliases: ["ts", "tsx"]
      });
      return tsLanguage;
    }
    module.exports = typescript2;
  }
});

// package/dist/modes/interactive/components/user-message.js
import { Container, Markdown } from "@earendil-works/pi-tui";

// package/dist/modes/interactive/theme/theme.js
import * as fs from "node:fs";
import { backgroundAnsi, colorToHex, colorToOklch as colorToOklch2, foregroundAnsi, getTerminalColorMode, indexedColor, mixColors, parseColor, rgbColor as rgbColor2, styleTextWithAnsi } from "@earendil-works/pi-tui";

// node_modules/chalk/source/utilities.js
function stringReplaceAll(string, substring, postfix) {
  let index = string.indexOf(substring);
  if (index === -1) {
    return string;
  }
  const substringLength = substring.length;
  let endIndex = 0;
  let returnValue = "";
  do {
    returnValue += string.slice(endIndex, index) + substring + postfix;
    endIndex = index + substringLength;
    index = string.indexOf(substring, endIndex);
  } while (index !== -1);
  returnValue += string.slice(endIndex);
  return returnValue;
}
function stringEncaseCRLFWithFirstIndex(string, prefix, postfix, index) {
  let endIndex = 0;
  let returnValue = "";
  do {
    const isGotCR = string[index - 1] === "\r";
    returnValue += string.slice(endIndex, isGotCR ? index - 1 : index) + prefix + (isGotCR ? "\r\n" : "\n") + postfix;
    endIndex = index + 1;
    index = string.indexOf("\n", endIndex);
  } while (index !== -1);
  returnValue += string.slice(endIndex);
  return returnValue;
}

// node_modules/chalk/source/vendor/ansi-styles/index.js
var ANSI_BACKGROUND_OFFSET = 10;
var ANSI_UNDERLINE_OFFSET = 20;
var wrapAnsi16 = (offset = 0) => (code) => `\x1B[${code + offset}m`;
var wrapAnsi256 = (offset = 0) => (code) => `\x1B[${38 + offset};5;${code}m`;
var wrapAnsi16m = (offset = 0) => (red, green, blue) => `\x1B[${38 + offset};2;${red};${green};${blue}m`;
var wrapUnderlineAnsi = (code) => `\x1B[58;5;${code < 90 ? code - 30 : code - 90 + 8}m`;
var styles = {
  modifier: {
    reset: [0, 0],
    // 21 isn't widely supported and 22 does the same thing
    bold: [1, 22],
    dim: [2, 22],
    italic: [3, 23],
    underline: [4, 24],
    // Extended underline styles (`SGR 4:x` sub-parameters). Not in upstream `ansi-styles`.
    underlineDouble: ["4:2", 24],
    underlineCurly: ["4:3", 24],
    underlineDotted: ["4:4", 24],
    underlineDashed: ["4:5", 24],
    overline: [53, 55],
    inverse: [7, 27],
    hidden: [8, 28],
    strikethrough: [9, 29]
  },
  color: {
    black: [30, 39],
    red: [31, 39],
    green: [32, 39],
    yellow: [33, 39],
    blue: [34, 39],
    magenta: [35, 39],
    cyan: [36, 39],
    white: [37, 39],
    // Bright color
    blackBright: [90, 39],
    gray: [90, 39],
    // Alias of `blackBright`
    grey: [90, 39],
    // Alias of `blackBright`
    redBright: [91, 39],
    greenBright: [92, 39],
    yellowBright: [93, 39],
    blueBright: [94, 39],
    magentaBright: [95, 39],
    cyanBright: [96, 39],
    whiteBright: [97, 39]
  },
  bgColor: {
    bgBlack: [40, 49],
    bgRed: [41, 49],
    bgGreen: [42, 49],
    bgYellow: [43, 49],
    bgBlue: [44, 49],
    bgMagenta: [45, 49],
    bgCyan: [46, 49],
    bgWhite: [47, 49],
    // Bright color
    bgBlackBright: [100, 49],
    bgGray: [100, 49],
    // Alias of `bgBlackBright`
    bgGrey: [100, 49],
    // Alias of `bgBlackBright`
    bgRedBright: [101, 49],
    bgGreenBright: [102, 49],
    bgYellowBright: [103, 49],
    bgBlueBright: [104, 49],
    bgMagentaBright: [105, 49],
    bgCyanBright: [106, 49],
    bgWhiteBright: [107, 49]
  },
  // Underline color (`SGR 58`/`59`). Not in upstream `ansi-styles`.
  underlineColor: {
    underlineBlack: ["58;5;0", 59],
    underlineRed: ["58;5;1", 59],
    underlineGreen: ["58;5;2", 59],
    underlineYellow: ["58;5;3", 59],
    underlineBlue: ["58;5;4", 59],
    underlineMagenta: ["58;5;5", 59],
    underlineCyan: ["58;5;6", 59],
    underlineWhite: ["58;5;7", 59],
    // Bright color
    underlineBlackBright: ["58;5;8", 59],
    underlineGray: ["58;5;8", 59],
    // Alias of `underlineBlackBright`
    underlineGrey: ["58;5;8", 59],
    // Alias of `underlineBlackBright`
    underlineRedBright: ["58;5;9", 59],
    underlineGreenBright: ["58;5;10", 59],
    underlineYellowBright: ["58;5;11", 59],
    underlineBlueBright: ["58;5;12", 59],
    underlineMagentaBright: ["58;5;13", 59],
    underlineCyanBright: ["58;5;14", 59],
    underlineWhiteBright: ["58;5;15", 59]
  }
};
var modifierNames = Object.keys(styles.modifier);
var foregroundColorNames = Object.keys(styles.color);
var backgroundColorNames = Object.keys(styles.bgColor);
var underlineColorNames = Object.keys(styles.underlineColor);
var colorNames = [...foregroundColorNames, ...backgroundColorNames];
function assembleStyles() {
  const codes = /* @__PURE__ */ new Map();
  for (const [groupName, group] of Object.entries(styles)) {
    for (const [styleName, style] of Object.entries(group)) {
      styles[styleName] = {
        open: `\x1B[${style[0]}m`,
        close: `\x1B[${style[1]}m`
      };
      group[styleName] = styles[styleName];
      codes.set(Number.parseInt(style[0], 10), style[1]);
    }
    Object.defineProperty(styles, groupName, {
      value: group,
      enumerable: false
    });
  }
  Object.defineProperty(styles, "codes", {
    value: codes,
    enumerable: false
  });
  styles.color.close = "\x1B[39m";
  styles.bgColor.close = "\x1B[49m";
  styles.underlineColor.close = "\x1B[59m";
  styles.color.ansi = wrapAnsi16();
  styles.color.ansi256 = wrapAnsi256();
  styles.color.ansi16m = wrapAnsi16m();
  styles.bgColor.ansi = wrapAnsi16(ANSI_BACKGROUND_OFFSET);
  styles.bgColor.ansi256 = wrapAnsi256(ANSI_BACKGROUND_OFFSET);
  styles.bgColor.ansi16m = wrapAnsi16m(ANSI_BACKGROUND_OFFSET);
  styles.underlineColor.ansi = wrapUnderlineAnsi;
  styles.underlineColor.ansi256 = wrapAnsi256(ANSI_UNDERLINE_OFFSET);
  styles.underlineColor.ansi16m = wrapAnsi16m(ANSI_UNDERLINE_OFFSET);
  Object.defineProperties(styles, {
    rgbToAnsi256: {
      value(red, green, blue) {
        if (red === green && green === blue) {
          if (red < 8) {
            return 16;
          }
          if (red > 248) {
            return 231;
          }
          return Math.round((red - 8) / 247 * 24) + 232;
        }
        return 16 + 36 * Math.round(red / 255 * 5) + 6 * Math.round(green / 255 * 5) + Math.round(blue / 255 * 5);
      },
      enumerable: false
    },
    hexToRgb: {
      value(hex) {
        const matches = /[\da-f]{6}|[\da-f]{3}/i.exec(hex.toString(16));
        if (!matches) {
          return [0, 0, 0];
        }
        let [colorString] = matches;
        if (colorString.length === 3) {
          colorString = [...colorString].map((character) => character + character).join("");
        }
        const integer = Number.parseInt(colorString, 16);
        return [
          /* eslint-disable no-bitwise -- We need the speed */
          integer >> 16 & 255,
          integer >> 8 & 255,
          integer & 255
          /* eslint-enable no-bitwise */
        ];
      },
      enumerable: false
    },
    hexToAnsi256: {
      value: (hex) => styles.rgbToAnsi256(...styles.hexToRgb(hex)),
      enumerable: false
    },
    ansi256ToAnsi: {
      value(code) {
        if (code < 8) {
          return 30 + code;
        }
        if (code < 16) {
          return 90 + (code - 8);
        }
        let red;
        let green;
        let blue;
        if (code >= 232) {
          red = ((code - 232) * 10 + 8) / 255;
          green = red;
          blue = red;
        } else {
          code -= 16;
          const remainder = code % 36;
          red = Math.floor(code / 36) / 5;
          green = Math.floor(remainder / 6) / 5;
          blue = remainder % 6 / 5;
        }
        const value = Math.max(red, green, blue) * 2;
        if (value === 0) {
          return 30;
        }
        let result = 30 + (Math.round(blue) << 2 | Math.round(green) << 1 | Math.round(red));
        if (value === 2) {
          result += 60;
        }
        return result;
      },
      enumerable: false
    },
    rgbToAnsi: {
      value: (red, green, blue) => styles.ansi256ToAnsi(styles.rgbToAnsi256(red, green, blue)),
      enumerable: false
    },
    hexToAnsi: {
      value: (hex) => styles.ansi256ToAnsi(styles.hexToAnsi256(hex)),
      enumerable: false
    }
  });
  return styles;
}
var ansiStyles = assembleStyles();
var ansi_styles_default = ansiStyles;

// node_modules/chalk/source/vendor/supports-color/index.js
import process2 from "node:process";
import os from "node:os";
import tty from "node:tty";
function hasFlag(flag, argv = globalThis.Deno ? globalThis.Deno.args : process2.argv) {
  const prefix = flag.startsWith("-") ? "" : flag.length === 1 ? "-" : "--";
  const position = argv.indexOf(prefix + flag);
  const terminatorPosition = argv.indexOf("--");
  return position !== -1 && (terminatorPosition === -1 || position < terminatorPosition);
}
var { env } = process2;
var flagForceColor;
if (hasFlag("no-color") || hasFlag("no-colors") || hasFlag("color=false") || hasFlag("color=never")) {
  flagForceColor = 0;
} else if (hasFlag("color") || hasFlag("colors") || hasFlag("color=true") || hasFlag("color=always")) {
  flagForceColor = 1;
}
function hasNumericForceColor() {
  return /^\d+$/.test(env.FORCE_COLOR);
}
function envForceColor() {
  if (!("FORCE_COLOR" in env)) {
    return;
  }
  if (env.FORCE_COLOR === "false") {
    return 0;
  }
  if (env.FORCE_COLOR === "true" || env.FORCE_COLOR.length === 0) {
    return 1;
  }
  if (!hasNumericForceColor()) {
    return;
  }
  return Math.min(Number.parseInt(env.FORCE_COLOR, 10), 3);
}
function translateLevel(level) {
  if (level === 0) {
    return false;
  }
  return {
    level,
    hasBasic: true,
    has256: level >= 2,
    has16m: level >= 3
  };
}
function _supportsColor(haveStream, { streamIsTTY, sniffFlags = true } = {}) {
  const noFlagForceColor = envForceColor();
  if (noFlagForceColor !== void 0) {
    flagForceColor = noFlagForceColor;
  }
  const forceColor = sniffFlags ? flagForceColor : noFlagForceColor;
  if (forceColor === 0) {
    return 0;
  }
  if (sniffFlags) {
    if (hasFlag("color=16m") || hasFlag("color=full") || hasFlag("color=truecolor")) {
      return 3;
    }
    if (hasFlag("color=256")) {
      return 2;
    }
  }
  if (forceColor !== void 0 && hasNumericForceColor()) {
    return forceColor;
  }
  if ("TF_BUILD" in env && "AGENT_NAME" in env) {
    return 1;
  }
  if (haveStream && !streamIsTTY && forceColor === void 0) {
    return 0;
  }
  const min = forceColor || 0;
  if (env.TERM === "dumb") {
    return min;
  }
  if (process2.platform === "win32") {
    const osRelease = os.release().split(".");
    if (Number(osRelease[0]) >= 10 && Number(osRelease[2]) >= 10586) {
      return Number(osRelease[2]) >= 14931 ? 3 : 2;
    }
    return 1;
  }
  if ("CI" in env) {
    if (["GITHUB_ACTIONS", "GITEA_ACTIONS", "CIRCLECI"].some((key) => key in env)) {
      return 3;
    }
    if (["TRAVIS", "APPVEYOR", "GITLAB_CI", "BUILDKITE", "DRONE"].some((sign) => sign in env) || env.CI_NAME === "codeship") {
      return 1;
    }
    return min;
  }
  if ("TEAMCITY_VERSION" in env) {
    return /^(?:9\.0*[1-9]\d*\.|\d{2,}\.)/.test(env.TEAMCITY_VERSION) ? 1 : 0;
  }
  if (env.COLORTERM === "truecolor") {
    return 3;
  }
  if (env.TERM === "xterm-kitty") {
    return 3;
  }
  if (env.TERM === "xterm-ghostty") {
    return 3;
  }
  if (env.TERM === "wezterm") {
    return 3;
  }
  if ("TERM_PROGRAM" in env) {
    const version = Number.parseInt((env.TERM_PROGRAM_VERSION || "").split(".", 1)[0], 10);
    switch (env.TERM_PROGRAM) {
      case "iTerm.app": {
        return version >= 3 ? 3 : 2;
      }
      case "Apple_Terminal": {
        return 2;
      }
    }
  }
  if (/-256(?:color)?$/i.test(env.TERM)) {
    return 2;
  }
  if (/^screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(env.TERM)) {
    return 1;
  }
  if ("COLORTERM" in env) {
    return 1;
  }
  return min;
}
function createSupportsColor(stream, options = {}) {
  const level = _supportsColor(stream, {
    streamIsTTY: stream && stream.isTTY,
    ...options
  });
  return translateLevel(level);
}
var supportsColor = {
  stdout: createSupportsColor({ isTTY: tty.isatty(1) }),
  stderr: createSupportsColor({ isTTY: tty.isatty(2) })
};
var supports_color_default = supportsColor;

// node_modules/chalk/source/index.js
var { stdout: stdoutColor, stderr: stderrColor } = supports_color_default;
var GENERATOR = Symbol("GENERATOR");
var STYLER = Symbol("STYLER");
var IS_EMPTY = Symbol("IS_EMPTY");
var LEVEL = Symbol("LEVEL");
var styles2 = /* @__PURE__ */ Object.create(null);
var assertValidLevel = (level) => {
  if (!Number.isSafeInteger(level) || level < 0 || level > 3) {
    throw new Error("The `level` should be an integer from 0 to 3");
  }
};
var levelDescriptor = {
  enumerable: true,
  get() {
    return this[LEVEL];
  },
  set(level) {
    assertValidLevel(level);
    this[LEVEL] = level;
  }
};
var applyOptions = (object, options = {}) => {
  if (options.level !== void 0) {
    assertValidLevel(options.level);
  }
  const colorLevel = stdoutColor ? stdoutColor.level : 0;
  object[LEVEL] = options.level === void 0 ? colorLevel : options.level;
};
var chalkFactory = (options) => {
  const chalk2 = (...strings) => strings.join(" ");
  applyOptions(chalk2, options);
  Object.setPrototypeOf(chalk2, createChalk.prototype);
  return chalk2;
};
function createChalk(options) {
  return chalkFactory(options);
}
Object.setPrototypeOf(createChalk.prototype, Function.prototype);
for (const [styleName, style] of Object.entries(ansi_styles_default)) {
  styles2[styleName] = {
    get() {
      const builder = createBuilder(this, createStyler(style.open, style.close, this[STYLER]), this[IS_EMPTY]);
      Object.defineProperty(this, styleName, { value: builder });
      return builder;
    }
  };
}
styles2.visible = {
  get() {
    const builder = createBuilder(this, this[STYLER], true);
    Object.defineProperty(this, "visible", { value: builder });
    return builder;
  }
};
var createModelConverters = (model, type) => {
  const style = ansi_styles_default[type];
  if (model === "rgb") {
    const ansi2 = (red, green, blue) => style.ansi(ansi_styles_default.rgbToAnsi(red, green, blue));
    const ansi256 = (red, green, blue) => style.ansi256(ansi_styles_default.rgbToAnsi256(red, green, blue));
    return [ansi2, ansi2, ansi256, style.ansi16m];
  }
  if (model === "hex") {
    const ansi2 = (hex) => style.ansi(ansi_styles_default.hexToAnsi(hex));
    const ansi256 = (hex) => style.ansi256(ansi_styles_default.hexToAnsi256(hex));
    return [ansi2, ansi2, ansi256, (hex) => style.ansi16m(...ansi_styles_default.hexToRgb(hex))];
  }
  const ansi = (code) => style.ansi(ansi_styles_default.ansi256ToAnsi(code));
  return [ansi, ansi, style.ansi256, style.ansi256];
};
var usedModels = ["rgb", "hex", "ansi256"];
for (const model of usedModels) {
  const capitalizedModel = model[0].toUpperCase() + model.slice(1);
  for (const [styleName, type] of [
    [model, "color"],
    ["bg" + capitalizedModel, "bgColor"],
    ["underline" + capitalizedModel, "underlineColor"]
  ]) {
    const { close } = ansi_styles_default[type];
    const converters = createModelConverters(model, type);
    styles2[styleName] = {
      get() {
        const styleFunction = function(first, second, third) {
          const open = converters[this.level](first, second, third);
          return createBuilder(this, createStyler(open, close, this[STYLER]), this[IS_EMPTY]);
        };
        Object.defineProperty(this, styleName, { value: styleFunction });
        return styleFunction;
      }
    };
  }
}
var proto = Object.defineProperties(
  () => {
  },
  {
    ...styles2,
    level: {
      enumerable: true,
      get() {
        return this[GENERATOR].level;
      },
      set(level) {
        this[GENERATOR].level = level;
      }
    }
  }
);
var createStyler = (open, close, parent) => {
  let openAll;
  let closeAll;
  if (parent === void 0) {
    openAll = open;
    closeAll = close;
  } else {
    openAll = parent.openAll + open;
    closeAll = close + parent.closeAll;
  }
  return {
    open,
    close,
    openAll,
    closeAll,
    parent
  };
};
var createBuilder = (self, _styler, _isEmpty) => {
  const builder = (...arguments_) => {
    if (arguments_.length === 1) {
      return applyStyle(builder, "" + arguments_[0]);
    }
    if (arguments_.length === 2) {
      return applyStyle(builder, arguments_[0] + " " + arguments_[1]);
    }
    return applyStyle(builder, arguments_.join(" "));
  };
  Object.setPrototypeOf(builder, proto);
  builder[GENERATOR] = self[GENERATOR] ?? self;
  builder[STYLER] = _styler;
  builder[IS_EMPTY] = _isEmpty;
  return builder;
};
var applyStyle = (self, string) => {
  if (self[GENERATOR][LEVEL] <= 0 || !string) {
    return self[IS_EMPTY] ? "" : string;
  }
  let styler = self[STYLER];
  if (styler === void 0) {
    return string;
  }
  const { openAll, closeAll } = styler;
  if (string.includes("\x1B")) {
    while (styler !== void 0) {
      string = stringReplaceAll(string, styler.close, styler.open);
      styler = styler.parent;
    }
  }
  const lfIndex = string.indexOf("\n");
  if (lfIndex !== -1) {
    string = stringEncaseCRLFWithFirstIndex(string, closeAll, openAll, lfIndex);
  }
  return openAll + string + closeAll;
};
Object.defineProperties(createChalk.prototype, { ...styles2, level: levelDescriptor });
var chalk = createChalk();
var chalkStderr = createChalk({ level: stderrColor ? stderrColor.level : 0 });
var source_default = chalk;

// boundary:ui-config
var getReadmePath = () => "/__pi_observer_no_resources__/README.md";

// package/dist/utils/fs-watch.js
function closeWatcher(watcher) {
  if (!watcher) {
    return;
  }
  try {
    watcher.close();
  } catch {
  }
}

// package/dist/utils/syntax-highlight.js
var import_core = __toESM(require_core(), 1);
var import_bash = __toESM(require_bash(), 1);
var import_c = __toESM(require_c(), 1);
var import_cpp = __toESM(require_cpp(), 1);
var import_csharp = __toESM(require_csharp(), 1);
var import_dart = __toESM(require_dart(), 1);
var import_go = __toESM(require_go(), 1);
var import_groovy = __toESM(require_groovy(), 1);
var import_java = __toESM(require_java(), 1);
var import_javascript = __toESM(require_javascript(), 1);
var import_json = __toESM(require_json(), 1);
var import_kotlin = __toESM(require_kotlin(), 1);
var import_lua = __toESM(require_lua(), 1);
var import_nix = __toESM(require_nix(), 1);
var import_perl = __toESM(require_perl(), 1);
var import_php = __toESM(require_php(), 1);
var import_python = __toESM(require_python(), 1);
var import_ruby = __toESM(require_ruby(), 1);
var import_rust = __toESM(require_rust(), 1);
var import_scala = __toESM(require_scala(), 1);
var import_swift = __toESM(require_swift(), 1);
var import_typescript = __toESM(require_typescript(), 1);

// package/dist/utils/html.js
function decodeCodePoint(codePoint) {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 1114111) {
    return void 0;
  }
  return String.fromCodePoint(codePoint);
}
function decodeHtmlEntity(entity) {
  switch (entity) {
    case "amp":
      return "&";
    case "lt":
      return "<";
    case "gt":
      return ">";
    case "quot":
      return '"';
    case "apos":
      return "'";
  }
  if (entity.startsWith("#x") || entity.startsWith("#X")) {
    return decodeCodePoint(Number.parseInt(entity.slice(2), 16));
  }
  if (entity.startsWith("#")) {
    return decodeCodePoint(Number.parseInt(entity.slice(1), 10));
  }
  return void 0;
}
function decodeHtmlEntityAt(html, index) {
  const semicolonIndex = html.indexOf(";", index + 1);
  if (semicolonIndex === -1 || semicolonIndex - index > 16) {
    return void 0;
  }
  const entity = html.slice(index + 1, semicolonIndex);
  const decoded = decodeHtmlEntity(entity);
  if (decoded === void 0) {
    return void 0;
  }
  return { text: decoded, length: semicolonIndex - index + 1 };
}

// package/dist/utils/syntax-highlight.js
var eagerLanguages = {
  python: import_python.default,
  java: import_java.default,
  go: import_go.default,
  javascript: import_javascript.default,
  json: import_json.default,
  cpp: import_cpp.default,
  typescript: import_typescript.default,
  php: import_php.default,
  ruby: import_ruby.default,
  c: import_c.default,
  csharp: import_csharp.default,
  nix: import_nix.default,
  bash: import_bash.default,
  rust: import_rust.default,
  scala: import_scala.default,
  kotlin: import_kotlin.default,
  swift: import_swift.default,
  dart: import_dart.default,
  groovy: import_groovy.default,
  perl: import_perl.default,
  lua: import_lua.default
};
for (const [name, language] of Object.entries(eagerLanguages)) {
  import_core.default.registerLanguage(name, language);
}
var SPAN_CLOSE = "</span>";
var HIGHLIGHT_CLASS_PREFIX = "hljs-";
function getScopeFromSpanTag(tag) {
  const match = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
  const classValue = match?.[1] ?? match?.[2];
  if (!classValue) {
    return void 0;
  }
  for (const className of classValue.split(/\s+/)) {
    if (className.startsWith(HIGHLIGHT_CLASS_PREFIX)) {
      return className.slice(HIGHLIGHT_CLASS_PREFIX.length);
    }
  }
  return void 0;
}
function getScopeFormatter(scope, theme2) {
  const exact = theme2[scope];
  if (exact) {
    return exact;
  }
  const dotIndex = scope.indexOf(".");
  if (dotIndex !== -1) {
    const prefixFormatter = theme2[scope.slice(0, dotIndex)];
    if (prefixFormatter) {
      return prefixFormatter;
    }
  }
  const dashIndex = scope.indexOf("-");
  if (dashIndex !== -1) {
    const prefixFormatter = theme2[scope.slice(0, dashIndex)];
    if (prefixFormatter) {
      return prefixFormatter;
    }
  }
  return void 0;
}
function getActiveFormatter(scopes, theme2) {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i];
    if (!scope) {
      continue;
    }
    const formatter = getScopeFormatter(scope, theme2);
    if (formatter) {
      return formatter;
    }
  }
  return theme2.default;
}
function isSpanOpenTagStart(html, index) {
  if (!html.startsWith("<span", index)) {
    return false;
  }
  const nextChar = html[index + "<span".length];
  return nextChar === ">" || nextChar === " " || nextChar === "	" || nextChar === "\n" || nextChar === "\r";
}
function renderHighlightedHtml(html, theme2 = {}) {
  let output = "";
  let textBuffer = "";
  const scopes = [];
  const flushText = () => {
    if (!textBuffer) {
      return;
    }
    const formatter = getActiveFormatter(scopes, theme2);
    output += formatter ? textBuffer.split("\n").map((line) => line ? formatter(line) : line).join("\n") : textBuffer;
    textBuffer = "";
  };
  let index = 0;
  while (index < html.length) {
    if (isSpanOpenTagStart(html, index)) {
      const tagEndIndex = html.indexOf(">", index + 5);
      if (tagEndIndex !== -1) {
        flushText();
        const tag = html.slice(index, tagEndIndex + 1);
        const scope = getScopeFromSpanTag(tag);
        scopes.push(scope);
        index = tagEndIndex + 1;
        continue;
      }
    }
    if (html.startsWith(SPAN_CLOSE, index)) {
      flushText();
      if (scopes.length > 0) {
        scopes.pop();
      }
      index += SPAN_CLOSE.length;
      continue;
    }
    if (html[index] === "&") {
      const decoded = decodeHtmlEntityAt(html, index);
      if (decoded) {
        textBuffer += decoded.text;
        index += decoded.length;
        continue;
      }
    }
    textBuffer += html[index];
    index++;
  }
  flushText();
  return output;
}
function highlight(code, options = {}) {
  const html = options.language ? import_core.default.highlight(code, {
    language: options.language,
    ignoreIllegals: options.ignoreIllegals
  }).value : import_core.default.highlightAuto(code, options.languageSubset).value;
  return renderHighlightedHtml(html, options.theme);
}
function supportsLanguage(name) {
  return import_core.default.getLanguage(name) !== void 0;
}

// package/dist/utils/text.js
function splitBom(content) {
  return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}
function stripBom(content) {
  return splitBom(content).text;
}

// package/dist/modes/interactive/theme/system-theme.js
import { colorToOkhsl, colorToOklch, colorToRgb, okhslColor, oklabToOkhslLightness, oklchColor, rgbColor } from "@earendil-works/pi-tui";
var TOOL_PANELS = ["toolPendingBg", "toolSuccessBg", "toolErrorBg"];
var MESSAGE_PANELS = ["userMessageBg", "customMessageBg"];
var PANELS = [
  "userMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
  "selectedBg",
  "searchMatchBg",
  "customMessageBg"
];
var THINKING = [
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "thinkingMax"
];
var THINKING_LEVELS = [
  "thinking0",
  "thinking1",
  "thinking2",
  "thinking3",
  "thinking4",
  "thinking5",
  "thinking6"
];
var each = (tokens, on, level) => tokens.map((token) => ({ token, on, level }));
var RULES = [
  ...each(PANELS, ["background"], "panel"),
  { token: "text", on: ["background"], level: "text" },
  { token: "text", on: ["selectedBg"], level: "textOnPanel" },
  { token: "userMessageText", on: ["userMessageBg"], level: "textOnPanel" },
  { token: "toolTitle", on: TOOL_PANELS, level: "textOnPanel" },
  ...each(["accent", "success", "error", "warning"], ["background", "selectedBg", ...TOOL_PANELS], "readable"),
  { token: "muted", on: ["background", "selectedBg", "customMessageBg", ...TOOL_PANELS], level: "readable" },
  { token: "dim", on: ["background", "selectedBg", "customMessageBg", ...TOOL_PANELS], level: "subtle" },
  { token: "thinkingText", on: ["background"], level: "readable" },
  { token: "customMessageText", on: ["customMessageBg", ...TOOL_PANELS], level: "readable" },
  {
    token: "customMessageLabel",
    on: ["background", "customMessageBg", "selectedBg", ...TOOL_PANELS],
    level: "readable"
  },
  { token: "toolOutput", on: ["background", ...TOOL_PANELS], level: "readable" },
  ...each(["mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdQuote", "mdCodeBlockBorder", "mdListBullet"], ["background", ...MESSAGE_PANELS], "readable"),
  { token: "mdCodeBlock", on: ["background", ...MESSAGE_PANELS, ...TOOL_PANELS], level: "readable" },
  ...each(["toolDiffAdded", "toolDiffRemoved", "toolDiffContext"], ["background", ...TOOL_PANELS], "readable"),
  ...each([
    "syntaxComment",
    "syntaxKeyword",
    "syntaxFunction",
    "syntaxVariable",
    "syntaxString",
    "syntaxNumber",
    "syntaxType",
    "syntaxOperator",
    "syntaxPunctuation"
  ], ["background", ...MESSAGE_PANELS, ...TOOL_PANELS], "readable"),
  { token: "searchMatchText", on: ["searchMatchBg"], level: "readable" },
  ...each(["bashMode", "border", "borderAccent"], ["background"], "readable"),
  { token: "borderMuted", on: ["background"], level: "subtle" },
  ...each(["mdQuoteBorder", "mdHr"], ["background", ...MESSAGE_PANELS, ...TOOL_PANELS], "readable"),
  { token: "scrollbarTrack", on: ["background"], level: "track" },
  { token: "scrollbarThumb", on: ["scrollbarTrack"], level: "thumb" },
  ...THINKING.map((token, index) => ({ token, on: ["background"], level: THINKING_LEVELS[index] }))
];
var TEXT_MINIMUM_WCAG_CONTRAST = 4.5;
var SOLVE_ORDER = (() => {
  const order = [];
  const visit = (token) => {
    if (order.includes(token))
      return;
    for (const rule of RULES) {
      if (rule.token !== token)
        continue;
      for (const surface of rule.on)
        if (surface !== "background")
          visit(surface);
    }
    order.push(token);
  };
  for (const rule of RULES)
    visit(rule.token);
  return order;
})();
function oklabLightness(color) {
  return colorToOklch(rgbColor(color.r, color.g, color.b)).l;
}
function relativeLuminance({ r, g, b }) {
  const linear = (channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}
function wcagContrast(first, second) {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function terminalAppearance(background, foreground) {
  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 0, g: 0, b: 0 };
  const whiteContrast = wcagContrast(white, background);
  const blackContrast = wcagContrast(black, background);
  if (foreground) {
    const foregroundL = oklabLightness(foreground);
    const backgroundL = oklabLightness(background);
    if (Math.abs(foregroundL - backgroundL) > 0.05) {
      const appearance = foregroundL > backgroundL ? "dark" : "light";
      const best = appearance === "dark" ? whiteContrast : blackContrast;
      if (best >= TEXT_MINIMUM_WCAG_CONTRAST)
        return appearance;
    }
  }
  return whiteContrast >= blackContrast ? "dark" : "light";
}

// package/dist/modes/interactive/theme/theme-tokens.js
function defineThemeTokens(tokens) {
  for (const [name, descriptor] of Object.entries(tokens)) {
    if (descriptor.fallback === void 0)
      continue;
    const fallback = tokens[descriptor.fallback];
    if (fallback === void 0) {
      throw new Error(`Theme token ${name} has unknown fallback ${descriptor.fallback}`);
    }
    if (fallback.slot !== descriptor.slot) {
      throw new Error(`Theme token ${name} has fallback ${descriptor.fallback} in a different color slot`);
    }
  }
  return tokens;
}
var THEME_TOKENS = defineThemeTokens({
  accent: { slot: "foreground", description: "Primary accent color (logo, selected items, cursor)" },
  border: { slot: "foreground", description: "Normal borders" },
  borderAccent: { slot: "foreground", description: "Highlighted borders" },
  borderMuted: { slot: "foreground", description: "Subtle borders" },
  success: { slot: "foreground", description: "Success states" },
  error: { slot: "foreground", description: "Error states" },
  warning: { slot: "foreground", description: "Warning states" },
  muted: { slot: "foreground", description: "Secondary/dimmed text" },
  dim: { slot: "foreground", description: "Very dimmed text (more subtle than muted)" },
  text: { slot: "foreground", description: "Default text color (usually empty string)" },
  thinkingText: { slot: "foreground", description: "Thinking block text color" },
  scrollbarTrack: {
    slot: "foreground",
    description: "Fullscreen scrollbar track foreground (falls back to muted when omitted)",
    fallback: "muted"
  },
  scrollbarThumb: {
    slot: "foreground",
    description: "Fullscreen scrollbar thumb foreground (falls back to text when omitted)",
    fallback: "text"
  },
  selectedBg: { slot: "background", description: "Selected item background" },
  searchMatchBg: {
    slot: "background",
    description: "Transcript search match background and current-match text (falls back to selectedBg when omitted)",
    fallback: "selectedBg"
  },
  searchMatchText: {
    slot: "foreground",
    description: "Transcript search match text and current-match background (falls back to text when omitted)",
    fallback: "text"
  },
  userMessageBg: { slot: "background", description: "User message background" },
  userMessageText: { slot: "foreground", description: "User message text color" },
  customMessageBg: { slot: "background", description: "Custom message background (hook-injected messages)" },
  customMessageText: { slot: "foreground", description: "Custom message text color" },
  customMessageLabel: { slot: "foreground", description: "Custom message type label color" },
  toolPendingBg: { slot: "background", description: "Tool execution box (pending state)" },
  toolSuccessBg: { slot: "background", description: "Tool execution box (success state)" },
  toolErrorBg: { slot: "background", description: "Tool execution box (error state)" },
  toolTitle: { slot: "foreground", description: "Tool execution box title color" },
  toolOutput: { slot: "foreground", description: "Tool execution box output text color" },
  mdHeading: { slot: "foreground", description: "Markdown heading text" },
  mdLink: { slot: "foreground", description: "Markdown link text" },
  mdLinkUrl: { slot: "foreground", description: "Markdown link URL" },
  mdCode: { slot: "foreground", description: "Markdown inline code" },
  mdCodeBlock: { slot: "foreground", description: "Markdown code block content" },
  mdCodeBlockBorder: { slot: "foreground", description: "Markdown code block fences" },
  mdQuote: { slot: "foreground", description: "Markdown blockquote text" },
  mdQuoteBorder: { slot: "foreground", description: "Markdown blockquote border" },
  mdHr: { slot: "foreground", description: "Markdown horizontal rule" },
  mdListBullet: { slot: "foreground", description: "Markdown list bullets/numbers" },
  toolDiffAdded: { slot: "foreground", description: "Added lines in tool diffs" },
  toolDiffRemoved: { slot: "foreground", description: "Removed lines in tool diffs" },
  toolDiffContext: { slot: "foreground", description: "Context lines in tool diffs" },
  syntaxComment: { slot: "foreground", description: "Syntax highlighting: comments" },
  syntaxKeyword: { slot: "foreground", description: "Syntax highlighting: keywords" },
  syntaxFunction: { slot: "foreground", description: "Syntax highlighting: function names" },
  syntaxVariable: { slot: "foreground", description: "Syntax highlighting: variable names" },
  syntaxString: { slot: "foreground", description: "Syntax highlighting: string literals" },
  syntaxNumber: { slot: "foreground", description: "Syntax highlighting: number literals" },
  syntaxType: { slot: "foreground", description: "Syntax highlighting: type names" },
  syntaxOperator: { slot: "foreground", description: "Syntax highlighting: operators" },
  syntaxPunctuation: { slot: "foreground", description: "Syntax highlighting: punctuation" },
  thinkingOff: { slot: "foreground", description: "Thinking level border: off" },
  thinkingMinimal: { slot: "foreground", description: "Thinking level border: minimal" },
  thinkingLow: { slot: "foreground", description: "Thinking level border: low" },
  thinkingMedium: { slot: "foreground", description: "Thinking level border: medium" },
  thinkingHigh: { slot: "foreground", description: "Thinking level border: high" },
  thinkingXhigh: { slot: "foreground", description: "Thinking level border: xhigh" },
  thinkingMax: {
    slot: "foreground",
    description: "Thinking level border: max (falls back to thinkingXhigh when omitted)",
    fallback: "thinkingXhigh"
  },
  bashMode: { slot: "foreground", description: "Editor border color in bash mode" }
});

// package/dist/modes/interactive/theme/theme.js
var themeJsonValidator;
function resolveVarRefs(value, vars, visited = /* @__PURE__ */ new Set()) {
  if (typeof value === "number" || value === "" || value.startsWith("#") || /^ok(lch|hsl)\(/i.test(value)) {
    return value;
  }
  if (visited.has(value)) {
    throw new Error(`Circular variable reference detected: ${value}`);
  }
  if (!(value in vars)) {
    throw new Error(`Variable reference not found: ${value}`);
  }
  visited.add(value);
  return resolveVarRefs(vars[value], vars, visited);
}
function resolveThemeColors(colors, vars = {}) {
  const resolved = {};
  for (const [key, value] of Object.entries(colors)) {
    resolved[key] = resolveVarRefs(value, vars);
  }
  return resolved;
}
function withThemeTokenFallbacks(values) {
  const resolved = { ...values };
  for (const [rawName, descriptor] of Object.entries(THEME_TOKENS)) {
    if (!("fallback" in descriptor))
      continue;
    const name = rawName;
    if (resolved[name] !== void 0)
      continue;
    const fallback = descriptor.fallback;
    const fallbackValue = resolved[fallback];
    if (fallbackValue === void 0) {
      throw new Error(`Theme token ${rawName} has unresolved fallback ${descriptor.fallback}`);
    }
    resolved[name] = fallbackValue;
  }
  return resolved;
}
var terminalColors = {};
var terminalColorScheme;
var GUESSED_DEFAULT_COLORS = {
  dark: { foreground: parseColor("#e5e5e7"), background: parseColor("#000000") },
  light: { foreground: parseColor("#000000"), background: parseColor("#ffffff") }
};
function averageLightness(colors) {
  const fixed = colors.filter((color) => color.kind !== "indexed" || color.index >= 16);
  if (fixed.length === 0)
    return void 0;
  return fixed.reduce((sum, color) => sum + colorToOklch2(color).l, 0) / fixed.length;
}
function detectAppearance(foregrounds, backgrounds) {
  const fg = averageLightness(foregrounds);
  const bg = averageLightness(backgrounds);
  if (fg !== void 0 && bg !== void 0)
    return bg < fg ? "dark" : "light";
  if (bg !== void 0)
    return bg < 0.5 ? "dark" : "light";
  if (fg !== void 0)
    return fg > 0.5 ? "dark" : "light";
  return void 0;
}
var Theme = class {
  name;
  sourcePath;
  sourceInfo;
  mode;
  // Precomputed escape sequences keep fg()/bg() on the render hot path to a lookup and concat.
  fgAnsi = /* @__PURE__ */ new Map();
  bgAnsi = /* @__PURE__ */ new Map();
  // Tokens set to "" have no color of their own; `colors` fills them from the terminal defaults.
  concreteColors = {};
  defaultForegroundTokens = [];
  defaultBackgroundTokens = [];
  // Foreground tokens rendered faint (SGR 2) on top of their color.
  dimTokens;
  ownAppearance;
  resolvedColors;
  constructor(fgColors, bgColors, mode, options = {}) {
    this.name = options.name;
    this.sourcePath = options.sourcePath;
    this.sourceInfo = options.sourceInfo;
    this.mode = mode;
    this.dimTokens = new Set(options.dim);
    const { fgColors: foregrounds, bgColors: backgrounds } = splitThemeColors(withThemeTokenFallbacks({ ...fgColors, ...bgColors }));
    const concreteForegrounds = [];
    const concreteBackgrounds = [];
    const addToken = (token, value, isBackground) => {
      if (value === "") {
        (isBackground ? this.defaultBackgroundTokens : this.defaultForegroundTokens).push(token);
        return isBackground ? "\x1B[49m" : "\x1B[39m";
      }
      const color = parseColor(value);
      this.concreteColors[token] = color;
      (isBackground ? concreteBackgrounds : concreteForegrounds).push(color);
      return isBackground ? backgroundAnsi(color, mode) : foregroundAnsi(color, mode);
    };
    for (const [token, value] of Object.entries(foregrounds)) {
      this.fgAnsi.set(token, addToken(token, value, false));
    }
    for (const [token, value] of Object.entries(backgrounds)) {
      this.bgAnsi.set(token, addToken(token, value, true));
    }
    this.ownAppearance = options.appearance ?? detectAppearance(concreteForegrounds, concreteBackgrounds);
  }
  /**
   * The background the theme is designed for: declared in the theme JSON, detected from its colors,
   * or, for themes without usable colors, the terminal's appearance.
   */
  get appearance() {
    return this.ownAppearance ?? getTerminalTheme();
  }
  /**
   * Concrete colors for all tokens. Tokens set to "" (terminal default) use the terminal's reported
   * default colors, or a guess based on `appearance` when the terminal did not report them. Faint
   * tokens are approximated by mixing their color toward the background.
   */
  get colors() {
    const terminal = terminalColors;
    if (this.resolvedColors?.terminal !== terminal) {
      const guess = GUESSED_DEFAULT_COLORS[this.appearance];
      const toColor = (rgb, fallback) => rgb ? rgbColor2(rgb.r, rgb.g, rgb.b) : fallback;
      const foreground = toColor(terminal.foreground, guess.foreground);
      const background = toColor(terminal.background, guess.background);
      const colors = { ...this.concreteColors };
      for (const token of this.defaultForegroundTokens)
        colors[token] = foreground;
      for (const token of this.defaultBackgroundTokens)
        colors[token] = background;
      for (const token of this.dimTokens) {
        const color = colors[token];
        if (color)
          colors[token] = mixColors(color, background, 0.4);
      }
      this.resolvedColors = { terminal, colors: Object.freeze(colors) };
    }
    return this.resolvedColors.colors;
  }
  style(text, options) {
    const { fg, bg } = options;
    if (typeof fg === "string" && this.dimTokens.has(fg))
      options = { ...options, dim: true };
    return styleTextWithAnsi(text, fg === void 0 ? void 0 : typeof fg === "string" ? this.tokenAnsi(this.fgAnsi, fg) : foregroundAnsi(fg, this.mode), bg === void 0 ? void 0 : typeof bg === "string" ? this.tokenAnsi(this.bgAnsi, bg) : backgroundAnsi(bg, this.mode), options);
  }
  fg(color, text) {
    const ansi = this.tokenAnsi(this.fgAnsi, color);
    if (this.dimTokens.has(color))
      return `${ansi}\x1B[2m${text}\x1B[22;39m`;
    return `${ansi}${text}\x1B[39m`;
  }
  bg(color, text) {
    const ansi = this.tokenAnsi(this.bgAnsi, color);
    return `${ansi}${text}\x1B[49m`;
  }
  tokenAnsi(ansi, token) {
    const value = ansi.get(token);
    if (value === void 0)
      throw new Error(`Unknown theme color: ${token}`);
    return value;
  }
  bold(text) {
    return source_default.bold(text);
  }
  italic(text) {
    return source_default.italic(text);
  }
  underline(text) {
    return source_default.underline(text);
  }
  inverse(text) {
    return source_default.inverse(text);
  }
  strikethrough(text) {
    return source_default.strikethrough(text);
  }
  /** Opening escape sequence for a foreground token. Faint tokens include SGR 2, which `\x1b[22m` closes. */
  getFgAnsi(color) {
    const ansi = this.tokenAnsi(this.fgAnsi, color);
    return this.dimTokens.has(color) ? `${ansi}\x1B[2m` : ansi;
  }
  getBgAnsi(color) {
    return this.tokenAnsi(this.bgAnsi, color);
  }
  getColorMode() {
    return this.mode;
  }
  getThinkingBorderColor(level) {
    switch (level) {
      case "off":
        return (str2) => this.fg("thinkingOff", str2);
      case "minimal":
        return (str2) => this.fg("thinkingMinimal", str2);
      case "low":
        return (str2) => this.fg("thinkingLow", str2);
      case "medium":
        return (str2) => this.fg("thinkingMedium", str2);
      case "high":
        return (str2) => this.fg("thinkingHigh", str2);
      case "xhigh":
        return (str2) => this.fg("thinkingXhigh", str2);
      case "max":
        return (str2) => this.fg("thinkingMax", str2);
      default:
        return (str2) => this.fg("thinkingOff", str2);
    }
  }
  getBashModeBorderColor() {
    return (str2) => this.fg("bashMode", str2);
  }
};
function parseThemeJson(label, json2) {
  if (themeJsonValidator)
    return themeJsonValidator(label, json2);
  if (typeof json2 !== "object" || json2 === null || !("colors" in json2)) {
    throw new Error(`Invalid theme "${label}": expected an object with a "colors" map.`);
  }
  return json2;
}
function parseThemeJsonContent(label, content) {
  let json2;
  try {
    json2 = JSON.parse(stripBom(content));
  } catch (error) {
    throw new Error(`Failed to parse theme ${label}: ${error}`);
  }
  return parseThemeJson(label, json2);
}
function splitThemeColors(colors) {
  const fgColors = {};
  const bgColors = {};
  for (const [key, value] of Object.entries(colors)) {
    if (THEME_TOKENS[key].slot === "background") {
      bgColors[key] = value;
    } else {
      fgColors[key] = value;
    }
  }
  return { fgColors, bgColors };
}
function createTheme(themeJson, mode, sourcePath) {
  const colorMode = mode ?? getTerminalColorMode();
  const resolvedColors = withThemeTokenFallbacks(resolveThemeColors(themeJson.colors, themeJson.vars));
  const { fgColors, bgColors } = splitThemeColors(resolvedColors);
  return new Theme(fgColors, bgColors, colorMode, {
    name: themeJson.name,
    sourcePath,
    appearance: themeJson.appearance
  });
}
function loadThemeFromPath(themePath, mode) {
  const content = fs.readFileSync(themePath, "utf-8");
  const themeJson = parseThemeJsonContent(themePath, content);
  return createTheme(themeJson, mode, themePath);
}
function detectColorFgBgTheme(env2 = process.env) {
  const bg = env2.COLORFGBG?.split(";").at(-1)?.trim();
  if (!bg || !/^\d{1,2}$/.test(bg))
    return void 0;
  const index = Number(bg);
  if (index > 15)
    return void 0;
  return index <= 6 || index === 8 ? "dark" : "light";
}
function detectTerminalTheme(colors = {}, reportedScheme, env2 = process.env) {
  const { background, foreground } = colors;
  if (background)
    return terminalAppearance(background, foreground);
  return reportedScheme ?? detectColorFgBgTheme(env2) ?? "dark";
}
function getTerminalTheme() {
  return detectTerminalTheme(terminalColors, terminalColorScheme);
}
var THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
var THEME_KEY_OLD = Symbol.for("@mariozechner/pi-coding-agent:theme");
var theme = new Proxy({}, {
  get(_target, prop) {
    const t = globalThis[THEME_KEY];
    if (!t)
      throw new Error("Theme not initialized. Call initTheme() first.");
    return t[prop];
  }
});
function setGlobalTheme(t) {
  globalThis[THEME_KEY] = t;
  globalThis[THEME_KEY_OLD] = t;
}
var currentThemeName;
var themeWatcher;
var themeReloadTimer;
var onThemeChangeCallback;
function setThemeInstance(themeInstance) {
  setGlobalTheme(themeInstance);
  currentThemeName = "<in-memory>";
  stopThemeWatcher();
  if (onThemeChangeCallback) {
    onThemeChangeCallback();
  }
}
function stopThemeWatcher() {
  if (themeReloadTimer) {
    clearTimeout(themeReloadTimer);
    themeReloadTimer = void 0;
  }
  closeWatcher(themeWatcher);
  themeWatcher = void 0;
}
var cachedHighlightThemeFor;
var cachedCliHighlightTheme;
function buildCliHighlightTheme(t) {
  return {
    keyword: (s) => t.fg("syntaxKeyword", s),
    built_in: (s) => t.fg("syntaxType", s),
    literal: (s) => t.fg("syntaxNumber", s),
    number: (s) => t.fg("syntaxNumber", s),
    regexp: (s) => t.fg("syntaxString", s),
    string: (s) => t.fg("syntaxString", s),
    subst: (s) => t.fg("text", s),
    comment: (s) => t.fg("syntaxComment", s),
    doctag: (s) => t.fg("syntaxComment", s),
    meta: (s) => t.fg("muted", s),
    function: (s) => t.fg("syntaxFunction", s),
    title: (s) => t.fg("syntaxFunction", s),
    class: (s) => t.fg("syntaxType", s),
    type: (s) => t.fg("syntaxType", s),
    tag: (s) => t.fg("syntaxPunctuation", s),
    name: (s) => t.fg("syntaxKeyword", s),
    attr: (s) => t.fg("syntaxVariable", s),
    variable: (s) => t.fg("syntaxVariable", s),
    params: (s) => t.fg("syntaxVariable", s),
    operator: (s) => t.fg("syntaxOperator", s),
    punctuation: (s) => t.fg("syntaxPunctuation", s),
    emphasis: (s) => t.italic(s),
    strong: (s) => t.bold(s),
    link: (s) => t.underline(s),
    addition: (s) => t.fg("toolDiffAdded", s),
    deletion: (s) => t.fg("toolDiffRemoved", s)
  };
}
function getCliHighlightTheme(t) {
  if (cachedHighlightThemeFor !== t || !cachedCliHighlightTheme) {
    cachedHighlightThemeFor = t;
    cachedCliHighlightTheme = buildCliHighlightTheme(t);
  }
  return cachedCliHighlightTheme;
}
function highlightCode(code, lang) {
  const validLang = lang && supportsLanguage(lang) ? lang : void 0;
  if (!validLang) {
    return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
  }
  const opts = {
    language: validLang,
    ignoreIllegals: true,
    theme: getCliHighlightTheme(theme)
  };
  try {
    return highlight(code, opts).split("\n");
  } catch {
    return code.split("\n");
  }
}
function getLanguageFromPath(filePath) {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext)
    return void 0;
  const extToLang = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    fish: "fish",
    ps1: "powershell",
    sql: "sql",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    sass: "sass",
    less: "less",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    md: "markdown",
    markdown: "markdown",
    dockerfile: "dockerfile",
    makefile: "makefile",
    cmake: "cmake",
    lua: "lua",
    perl: "perl",
    r: "r",
    scala: "scala",
    clj: "clojure",
    ex: "elixir",
    exs: "elixir",
    erl: "erlang",
    hs: "haskell",
    ml: "ocaml",
    vim: "vim",
    graphql: "graphql",
    proto: "protobuf",
    tf: "hcl",
    hcl: "hcl"
  };
  return extToLang[ext];
}
function getMarkdownTheme() {
  return {
    heading: (text) => theme.fg("mdHeading", text),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    underline: (text) => theme.underline(text),
    strikethrough: (text) => theme.strikethrough(text),
    highlightCode: (code, lang) => {
      const validLang = lang && supportsLanguage(lang) ? lang : void 0;
      if (!validLang) {
        return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
      }
      const opts = {
        language: validLang,
        ignoreIllegals: true,
        theme: getCliHighlightTheme(theme)
      };
      try {
        return highlight(code, opts).split("\n");
      } catch {
        return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
      }
    }
  };
}

// package/dist/modes/interactive/components/markdown-transform.js
function createMarkdownTransform(messageType, isStreaming, transformers) {
  return (markdown, availableWidth) => applyMarkdownTransformers(markdown, { messageType, isStreaming, availableWidth }, transformers);
}
function applyMarkdownTransformers(markdown, context, transformers) {
  let transformedMarkdown = markdown;
  for (const transformer of transformers) {
    try {
      const transformed = transformer(transformedMarkdown, context);
      if (typeof transformed === "string") {
        transformedMarkdown = transformed;
      }
    } catch {
    }
  }
  return transformedMarkdown;
}

// package/dist/modes/interactive/components/user-message.js
var OSC133_ZONE_START = "\x1B]133;A\x07";
var OSC133_ZONE_END = "\x1B]133;B\x07";
var OSC133_ZONE_FINAL = "\x1B]133;C\x07";
var UserMessageComponent = class extends Container {
  text;
  markdownTheme;
  outputPad;
  markdownTransformers;
  constructor(text, markdownTheme = getMarkdownTheme(), outputPad = 1, markdownTransformers = []) {
    super();
    this.text = text;
    this.markdownTheme = markdownTheme;
    this.outputPad = outputPad;
    this.markdownTransformers = markdownTransformers;
    this.rebuild();
  }
  setOutputPad(padding) {
    this.outputPad = padding;
    this.rebuild();
  }
  rebuild() {
    this.clear();
    this.addChild(new Markdown(this.text, this.outputPad, 1, this.markdownTheme, {
      color: (content) => theme.fg("userMessageText", content),
      bgColor: (content) => theme.bg("userMessageBg", content)
    }, {
      preserveOrderedListMarkers: true,
      preserveBackslashEscapes: true,
      transform: createMarkdownTransform("user", false, this.markdownTransformers)
    }));
  }
  render(width) {
    const lines = super.render(width);
    if (lines.length === 0) {
      return lines;
    }
    lines[0] = OSC133_ZONE_START + lines[0];
    lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
    return lines;
  }
};

// package/dist/modes/interactive/components/assistant-message.js
import { Container as Container2, Markdown as Markdown2, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
var OSC133_ZONE_START2 = "\x1B]133;A\x07";
var OSC133_ZONE_END2 = "\x1B]133;B\x07";
var OSC133_ZONE_FINAL2 = "\x1B]133;C\x07";
var AssistantMessageComponent = class extends Container2 {
  contentContainer;
  hideThinkingBlock;
  markdownTheme;
  hiddenThinkingLabel;
  outputPad;
  markdownTransformers;
  lastMessage;
  hasToolCalls = false;
  isStreaming = false;
  thinkingVisibilityOverrides = /* @__PURE__ */ new Map();
  constructor(message, hideThinkingBlock = false, markdownTheme = getMarkdownTheme(), hiddenThinkingLabel = "Thinking...", outputPad = 1, markdownTransformers = []) {
    super();
    this.hideThinkingBlock = hideThinkingBlock;
    this.markdownTheme = markdownTheme;
    this.hiddenThinkingLabel = hiddenThinkingLabel;
    this.outputPad = outputPad;
    this.markdownTransformers = markdownTransformers;
    this.contentContainer = new Container2();
    this.addChild(this.contentContainer);
    if (message) {
      this.updateContent(message);
    }
  }
  invalidate() {
    super.invalidate();
    if (this.lastMessage) {
      this.updateContent(this.lastMessage);
    }
  }
  setHideThinkingBlock(hide) {
    this.hideThinkingBlock = hide;
    this.thinkingVisibilityOverrides.clear();
    if (this.lastMessage) {
      this.updateContent(this.lastMessage);
    }
  }
  setHiddenThinkingLabel(label) {
    this.hiddenThinkingLabel = label;
    if (this.lastMessage) {
      this.updateContent(this.lastMessage);
    }
  }
  setOutputPad(padding) {
    this.outputPad = padding;
    if (this.lastMessage) {
      this.updateContent(this.lastMessage);
    }
  }
  render(width) {
    const lines = super.render(width);
    if (this.hasToolCalls || lines.length === 0) {
      return lines;
    }
    lines[0] = OSC133_ZONE_START2 + lines[0];
    lines[lines.length - 1] = OSC133_ZONE_END2 + OSC133_ZONE_FINAL2 + lines[lines.length - 1];
    return lines;
  }
  updateContent(message, isStreaming = this.isStreaming) {
    this.lastMessage = message;
    this.isStreaming = isStreaming;
    this.contentContainer.clear();
    const hasVisibleContent = message.content.some((c2) => c2.type === "text" && c2.text.trim() || c2.type === "thinking" && c2.thinking.trim());
    if (hasVisibleContent) {
      this.contentContainer.addChild(new Spacer(1));
    }
    let thinkingRunIndex = 0;
    for (let i = 0; i < message.content.length; i++) {
      const content = message.content[i];
      if (content.type === "text" && content.text.trim()) {
        this.contentContainer.addChild(new Markdown2(content.text.trim(), this.outputPad, 0, this.markdownTheme, void 0, {
          transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers)
        }));
      } else if (content.type === "thinking") {
        const thinkingBlocks = [];
        for (; i < message.content.length; i++) {
          const thinkingContent = message.content[i];
          if (thinkingContent.type !== "thinking") {
            break;
          }
          const thinking = thinkingContent.thinking.trim();
          if (thinking) {
            thinkingBlocks.push(thinking);
          }
        }
        i--;
        if (thinkingBlocks.length === 0) {
          continue;
        }
        const hasVisibleContentAfter = message.content.slice(i + 1).some((c2) => c2.type === "text" && c2.text.trim() || c2.type === "thinking" && c2.thinking.trim());
        const runIndex = thinkingRunIndex++;
        const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;
        const thinkingComponent = hidden ? new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0) : new Markdown2(thinkingBlocks.join("\n\n"), this.outputPad, 0, this.markdownTheme, {
          color: (text) => theme.fg("thinkingText", text),
          italic: true
        }, {
          transform: createMarkdownTransform("assistant-thinking", this.isStreaming, this.markdownTransformers)
        });
        this.contentContainer.addChild(new MouseRegion(thinkingComponent, (event) => {
          if (event.type !== "click" || event.button !== "left")
            return void 0;
          this.thinkingVisibilityOverrides.set(runIndex, !hidden);
          if (this.lastMessage)
            this.updateContent(this.lastMessage);
          return { handled: true };
        }));
        if (hasVisibleContentAfter) {
          this.contentContainer.addChild(new Spacer(1));
        }
      }
    }
    const hasToolCalls = message.content.some((c2) => c2.type === "toolCall");
    this.hasToolCalls = hasToolCalls;
    if (message.stopReason === "length") {
      this.contentContainer.addChild(new Spacer(1));
      this.contentContainer.addChild(new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0));
    } else if (!hasToolCalls) {
      if (message.stopReason === "aborted") {
        const abortMessage = message.errorMessage && message.errorMessage !== "Request was aborted" ? message.errorMessage : "Operation aborted";
        this.contentContainer.addChild(new Spacer(1));
        this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
      } else if (message.stopReason === "error") {
        const errorMsg = message.errorMessage || "Unknown error";
        this.contentContainer.addChild(new Spacer(1));
        this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
      }
    }
  }
};

// package/dist/modes/interactive/components/tool-execution.js
import { Box, Container as Container3, getCapabilities as getCapabilities2, Image, MouseRegion as MouseRegion2, Spacer as Spacer2, Text as Text2 } from "@earendil-works/pi-tui";

// package/dist/core/tools/render-utils.js
import * as os2 from "node:os";
import { pathToFileURL } from "node:url";
import { getCapabilities, getImageDimensions, hyperlink, imageFallback } from "@earendil-works/pi-tui";

// package/dist/utils/ansi.js
var ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
var OSC_START = "\\u001B\\]";
var CSI_START = "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?";
var CSI_FINAL = "[\\dA-PR-TZcf-nq-uy=><~]";
var ansiRegex = new RegExp(`(?:${OSC_START}[\\s\\S]*?${ST})|${CSI_START}${CSI_FINAL}`, "g");
var unfinishedAnsiAtEndRegex = new RegExp(`(?:${OSC_START}(?:[^\\u0007\\u009C\\u001B]|\\u001B(?!\\\\))*|${CSI_START})$`);
function stripAnsi(value) {
  if (typeof value !== "string") {
    throw new TypeError(`Expected a \`string\`, got \`${typeof value}\``);
  }
  if (!value.includes("\x1B") && !value.includes("\x9B")) {
    return value;
  }
  return value.replace(ansiRegex, "");
}

// package/dist/utils/paths.js
import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolvePath, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
var UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
function normalizeWindowsShellPath(filePath) {
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\"))
    return filePath;
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match)
    return filePath;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}
function normalizePath(input, options = {}) {
  let normalized = options.trim ? input.trim() : input;
  if (options.normalizeUnicodeSpaces) {
    normalized = normalized.replace(UNICODE_SPACES, " ");
  }
  if (options.stripAtPrefix && normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }
  if (process.platform === "win32") {
    normalized = normalizeWindowsShellPath(normalized);
  }
  if (options.expandTilde ?? true) {
    const home = options.homeDir ?? homedir();
    if (normalized === "~")
      return home;
    if (normalized.startsWith("~/") || process.platform === "win32" && normalized.startsWith("~\\")) {
      return join(home, normalized.slice(2));
    }
  }
  if (/^file:\/\//.test(normalized)) {
    return fileURLToPath(normalized);
  }
  return normalized;
}
function resolvePath(input, baseDir = process.cwd(), options = {}) {
  const normalized = normalizePath(input, options);
  const normalizedBaseDir = normalizePath(baseDir);
  return isAbsolute(normalized) ? nodeResolvePath(normalized) : nodeResolvePath(normalizedBaseDir, normalized);
}
function getCwdRelativePath(filePath, cwd) {
  const resolvedCwd = resolvePath(cwd);
  const resolvedPath = resolvePath(filePath, resolvedCwd);
  const relativePath = relative(resolvedCwd, resolvedPath);
  const isInsideCwd = relativePath === "" || relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
  return isInsideCwd ? relativePath || "." : void 0;
}
function formatPathRelativeToCwdOrAbsolute(filePath, cwd) {
  const absolutePath = resolvePath(filePath, cwd);
  return (getCwdRelativePath(absolutePath, cwd) ?? absolutePath).split(sep).join("/");
}

// package/dist/utils/shell.js
function sanitizeBinaryOutput(str2) {
  return str2.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "");
}

// package/dist/core/tools/render-utils.js
function shortenPath(path) {
  if (typeof path !== "string")
    return "";
  const home = os2.homedir();
  if (path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}
function linkPath(styledText, rawPath, cwd) {
  if (!getCapabilities().hyperlinks)
    return styledText;
  const absolutePath = resolvePath(rawPath, cwd);
  return hyperlink(styledText, pathToFileURL(absolutePath).href);
}
function str(value) {
  if (typeof value === "string")
    return value;
  if (value == null)
    return "";
  return null;
}
function parseLineNumber(value) {
  if (typeof value === "string" && value.trim() !== "")
    value = Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function formatReadLineRange(offset, limit) {
  if (offset == null && limit == null)
    return "";
  const start = offset == null ? 1 : parseLineNumber(offset);
  if (start === void 0)
    return "";
  if (limit == null)
    return `:${start}`;
  const count = parseLineNumber(limit);
  if (count === void 0)
    return "";
  const end = start + count - 1;
  return `:${start}${end ? `-${end}` : ""}`;
}
function replaceTabs(text) {
  return text.replace(/\t/g, "   ");
}
function normalizeDisplayText(text) {
  return text.replace(/\r/g, "");
}
function getTextOutput(result, showImages) {
  if (!result)
    return "";
  const textBlocks = result.content.filter((c2) => c2.type === "text");
  const imageBlocks = result.content.filter((c2) => c2.type === "image");
  let output = textBlocks.map((c2) => sanitizeBinaryOutput(stripAnsi(c2.text || "")).replace(/\r/g, "")).join("\n");
  const caps = getCapabilities();
  if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
    const imageIndicators = imageBlocks.map((img) => {
      const mimeType = img.mimeType ?? "image/unknown";
      const dims = img.data && img.mimeType ? getImageDimensions(img.data, img.mimeType) ?? void 0 : void 0;
      return imageFallback(mimeType, dims);
    }).join("\n");
    output = output ? `${output}
${imageIndicators}` : imageIndicators;
  }
  return output;
}
var COLLAPSED_ARGS_CHARS = 100;
function formatToolCallWithArgs(title, args, theme2, expanded) {
  const header = theme2.fg("toolTitle", theme2.bold(title));
  if (args == null)
    return header;
  const entries = typeof args === "object" && !Array.isArray(args) ? Object.entries(args) : [["args", args]];
  if (entries.length === 0)
    return header;
  if (expanded) {
    const lines = entries.map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
      return `  ${key}: ${replaceTabs(text).replace(/\r/g, "").split("\n").join("\n    ")}`;
    });
    return `${header}
${theme2.fg("muted", lines.join("\n"))}`;
  }
  const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
  const preview = pairs.length > COLLAPSED_ARGS_CHARS ? `${pairs.slice(0, COLLAPSED_ARGS_CHARS - 3)}...` : pairs;
  return `${header} ${theme2.fg("muted", preview)}`;
}
function formatToolDuration(ms) {
  const seconds = ms / 1e3;
  if (seconds < 60)
    return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  if (minutes < 60)
    return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}
function startToolTimer(context) {
  const state = context.state;
  if (context.executionStarted && state.startedAt === void 0) {
    state.startedAt = Date.now();
    state.endedAt = void 0;
  }
}
function toolTimerText(context, isPartial) {
  const state = context.state;
  if (state.startedAt !== void 0 && isPartial && !state.interval) {
    state.interval = setInterval(() => context.invalidate(), 1e3);
  }
  if (!isPartial || context.isError) {
    state.endedAt ??= Date.now();
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = void 0;
    }
  }
  if (!isPartial && context.durationMs !== void 0)
    return `Took ${formatToolDuration(context.durationMs)}`;
  if (state.startedAt === void 0)
    return void 0;
  const endTime = state.endedAt ?? Date.now();
  return `${isPartial ? "Elapsed" : "Took"} ${formatToolDuration(endTime - state.startedAt)}`;
}
function invalidArgText(theme2) {
  return theme2.fg("error", "[invalid arg]");
}
function renderToolPath(rawPath, theme2, cwd, options) {
  if (rawPath === null)
    return invalidArgText(theme2);
  const value = rawPath || options?.emptyFallback;
  if (!value)
    return theme2.fg("toolOutput", "...");
  return linkPath(theme2.fg("accent", shortenPath(value)), value, cwd);
}

// boundary:images-disabled
function ensurePngTranscoder() {
}

// package/dist/modes/interactive/components/keybinding-hints.js
import { getKeybindings } from "@earendil-works/pi-tui";
function formatKeyPart(part, options) {
  const displayPart = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
  return options.capitalize ? displayPart.charAt(0).toUpperCase() + displayPart.slice(1) : displayPart;
}
function formatKeyText(key, options = {}) {
  return key.split("/").map((k) => k.split("+").map((part) => formatKeyPart(part, options)).join("+")).join("/");
}
function formatKeys(keys, options = {}) {
  if (keys.length === 0)
    return "";
  return formatKeyText(keys.join("/"), options);
}
function keyText(keybinding) {
  return formatKeys(getKeybindings().getKeys(keybinding));
}
function keyHint(keybinding, description) {
  return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
}

// package/dist/modes/interactive/components/tool-execution.js
var FALLBACK_PREVIEW_LINES = 10;
var ToolExecutionComponent = class extends Container3 {
  contentBox;
  contentText;
  contentTextRegion;
  selfRenderContainer;
  selfRenderHeight = 0;
  callRendererComponent;
  resultRendererComponent;
  rendererState = {};
  imageComponents = [];
  /** Inputs of imageComponents, so updateDisplay can reuse images and keep their converted PNG data. */
  imageSources = [];
  imageSpacers = [];
  toolName;
  toolCallId;
  args;
  expanded = false;
  showImages;
  imageWidthCells;
  outputPad;
  isPartial = true;
  toolDefinition;
  ui;
  cwd;
  executionStarted = false;
  argsComplete = false;
  result;
  hideComponent = false;
  constructor(toolName, toolCallId, args, options = {}, toolDefinition, ui, cwd) {
    super();
    this.toolName = toolName;
    this.toolCallId = toolCallId;
    this.args = args;
    this.toolDefinition = toolDefinition;
    this.showImages = options.showImages ?? true;
    this.imageWidthCells = options.imageWidthCells ?? 60;
    this.outputPad = options.outputPad ?? 1;
    this.ui = ui;
    this.cwd = cwd;
    this.addChild(new Spacer2(1));
    this.contentBox = new Box(1, 1, (text) => theme.bg("toolPendingBg", text));
    this.contentText = new Text2("", 1, 1, (text) => theme.bg("toolPendingBg", text));
    this.contentTextRegion = this.createResultRegion(this.contentText);
    this.selfRenderContainer = new Container3();
    if (this.hasRendererDefinition()) {
      this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
    } else {
      this.addChild(this.contentTextRegion);
    }
    this.updateDisplay();
  }
  getCallRenderer() {
    return this.toolDefinition?.renderCall;
  }
  getResultRenderer() {
    return this.toolDefinition?.renderResult;
  }
  hasRendererDefinition() {
    return this.toolDefinition !== void 0;
  }
  getRenderShell() {
    return this.toolDefinition?.renderShell ?? "default";
  }
  getRenderContext(lastComponent) {
    return {
      args: this.args,
      toolCallId: this.toolCallId,
      invalidate: () => {
        this.invalidate();
        this.ui.requestRender();
      },
      lastComponent,
      state: this.rendererState,
      cwd: this.cwd,
      executionStarted: this.executionStarted,
      argsComplete: this.argsComplete,
      isPartial: this.isPartial,
      expanded: this.expanded,
      showImages: this.showImages,
      isError: this.result?.isError ?? false,
      durationMs: this.isPartial ? void 0 : this.result?.durationMs,
      outputPad: this.outputPad
    };
  }
  createCallFallback() {
    return new Text2(formatToolCallWithArgs(this.toolName, this.args, theme, this.expanded), 0, 0);
  }
  createResultFallback() {
    const output = this.getTextOutput();
    if (!output) {
      return void 0;
    }
    const lines = output.split("\n");
    const displayLines = this.expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
    const remaining = lines.length - displayLines.length;
    let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
    if (remaining > 0) {
      text += `${theme.fg("muted", `
... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
    }
    return new Text2(text, 0, 0);
  }
  createResultRegion(component) {
    return new MouseRegion2(component, (event) => {
      if (!this.result || event.type !== "click" || event.button !== "left")
        return void 0;
      this.setExpanded(!this.expanded);
      return { handled: true };
    });
  }
  updateArgs(args) {
    this.args = args;
    this.updateDisplay();
  }
  markExecutionStarted() {
    this.executionStarted = true;
    this.updateDisplay();
    this.ui.requestRender();
  }
  setArgsComplete() {
    this.argsComplete = true;
    this.updateDisplay();
    this.ui.requestRender();
  }
  updateResult(result, isPartial = false) {
    this.result = result;
    this.isPartial = isPartial;
    this.updateDisplay();
  }
  setExpanded(expanded) {
    this.expanded = expanded;
    this.updateDisplay();
  }
  setOutputPad(outputPad) {
    this.outputPad = outputPad;
    this.updateDisplay();
  }
  setShowImages(show) {
    this.showImages = show;
    this.updateDisplay();
  }
  setImageWidthCells(width) {
    this.imageWidthCells = Math.max(1, Math.floor(width));
    this.updateDisplay();
  }
  invalidate() {
    super.invalidate();
    this.updateDisplay();
  }
  render(width) {
    if (this.hideComponent) {
      return [];
    }
    if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
      const contentLines = this.selfRenderContainer.render(width);
      this.selfRenderHeight = contentLines.length;
      if (contentLines.length === 0 && this.imageComponents.length === 0) {
        return [];
      }
      const lines = [];
      if (contentLines.length > 0) {
        lines.push("");
        lines.push(...contentLines);
      }
      for (let i = 0; i < this.imageComponents.length; i++) {
        const spacer = this.imageSpacers[i];
        if (spacer) {
          lines.push(...spacer.render(width));
        }
        const imageComponent = this.imageComponents[i];
        if (imageComponent) {
          lines.push(...imageComponent.render(width));
        }
      }
      return lines;
    }
    return super.render(width);
  }
  handleMouse(event) {
    if (!this.hasRendererDefinition() || this.getRenderShell() !== "self")
      return super.handleMouse(event);
    if (event.y <= 0 || event.y > this.selfRenderHeight)
      return void 0;
    return this.selfRenderContainer.handleMouse({
      ...event,
      y: event.y - 1,
      height: this.selfRenderHeight
    });
  }
  updateDisplay() {
    const bgFn = this.isPartial ? (text) => theme.bg("toolPendingBg", text) : this.result?.isError ? (text) => theme.bg("toolErrorBg", text) : (text) => theme.bg("toolSuccessBg", text);
    let hasContent = false;
    this.hideComponent = false;
    if (this.hasRendererDefinition()) {
      const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
      if (renderContainer instanceof Box) {
        renderContainer.setBgFn(bgFn);
        renderContainer.setPaddingX(this.outputPad);
      }
      renderContainer.clear();
      const callRenderer = this.getCallRenderer();
      if (!callRenderer) {
        renderContainer.addChild(this.createResultRegion(this.createCallFallback()));
        hasContent = true;
      } else {
        try {
          const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
          this.callRendererComponent = component;
          renderContainer.addChild(this.createResultRegion(component));
          hasContent = true;
        } catch {
          this.callRendererComponent = void 0;
          renderContainer.addChild(this.createResultRegion(this.createCallFallback()));
          hasContent = true;
        }
      }
      if (this.result) {
        const resultRenderer = this.getResultRenderer();
        if (!resultRenderer) {
          const component = this.createResultFallback();
          if (component) {
            renderContainer.addChild(this.createResultRegion(component));
            hasContent = true;
          }
        } else {
          try {
            const component = resultRenderer({ content: this.result.content, details: this.result.details }, { expanded: this.expanded, isPartial: this.isPartial }, theme, this.getRenderContext(this.resultRendererComponent));
            this.resultRendererComponent = component;
            renderContainer.addChild(this.createResultRegion(component));
            hasContent = true;
          } catch {
            this.resultRendererComponent = void 0;
            const component = this.createResultFallback();
            if (component) {
              renderContainer.addChild(this.createResultRegion(component));
              hasContent = true;
            }
          }
        }
      }
    } else {
      this.contentText.setCustomBgFn(bgFn);
      this.contentText.setPaddingX(this.outputPad);
      this.contentText.setText(this.formatToolExecution());
      hasContent = true;
    }
    const previousImages = this.imageComponents;
    const previousSources = this.imageSources;
    for (const img of this.imageComponents) {
      this.removeChild(img);
    }
    this.imageComponents = [];
    this.imageSources = [];
    for (const spacer of this.imageSpacers) {
      this.removeChild(spacer);
    }
    this.imageSpacers = [];
    if (this.result) {
      const imageBlocks = this.result.content.filter((c2) => c2.type === "image");
      const caps = getCapabilities2();
      for (const img of imageBlocks) {
        if (caps.images && this.showImages && img.data && img.mimeType) {
          const spacer = new Spacer2(1);
          this.addChild(spacer);
          this.imageSpacers.push(spacer);
          const source = { data: img.data, mimeType: img.mimeType, widthCells: this.imageWidthCells };
          const index = this.imageComponents.length;
          const previous = previousSources[index];
          const imageComponent = previous?.data === source.data && previous.mimeType === source.mimeType && previous.widthCells === source.widthCells ? previousImages[index] : new Image(source.data, source.mimeType, { fallbackColor: (s) => theme.fg("toolOutput", s) }, { maxWidthCells: source.widthCells });
          if (source.mimeType !== "image/png") {
            ensurePngTranscoder(() => {
              this.invalidate();
              this.ui.requestRender();
            });
          }
          this.imageComponents.push(imageComponent);
          this.imageSources.push(source);
          this.addChild(imageComponent);
        }
      }
    }
    if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
      this.hideComponent = true;
    }
  }
  getTextOutput() {
    return getTextOutput(this.result, this.showImages);
  }
  formatToolExecution() {
    let text = theme.fg("toolTitle", theme.bold(this.toolName));
    const content = JSON.stringify(this.args, null, 2);
    if (content) {
      text += `

${content}`;
    }
    const output = this.getTextOutput();
    if (output) {
      text += `
${output}`;
    }
    return text;
  }
};

// package/dist/core/tools/renderers/bash.js
import { Container as Container4, Spacer as Spacer3, Text as Text4 } from "@earendil-works/pi-tui";

// package/dist/modes/interactive/components/visual-truncate.js
import { Text as Text3, truncateToWidth } from "@earendil-works/pi-tui";
function truncateToVisualLines(text, maxVisualLines, width, paddingX = 0, keep = "end") {
  if (!text) {
    return { visualLines: [], skippedCount: 0 };
  }
  const tempText = new Text3(text, paddingX, 0);
  const allVisualLines = tempText.render(width);
  if (allVisualLines.length <= maxVisualLines) {
    return { visualLines: allVisualLines, skippedCount: 0 };
  }
  const truncatedLines = keep === "start" ? allVisualLines.slice(0, maxVisualLines) : allVisualLines.slice(-maxVisualLines);
  const skippedCount = allVisualLines.length - maxVisualLines;
  return { visualLines: truncatedLines, skippedCount };
}
var VisualLinePreview = class {
  options;
  cachedWidth;
  cachedLines;
  constructor(options) {
    this.options = options;
  }
  render(width) {
    if (this.cachedLines === void 0 || this.cachedWidth !== width) {
      const { text, maxVisualLines, keep, formatHint } = this.options;
      const preview = truncateToVisualLines(text, maxVisualLines, width, 0, keep);
      const lines = preview.visualLines;
      if (preview.skippedCount > 0) {
        const hint = truncateToWidth(formatHint(preview.skippedCount), width, "...");
        this.cachedLines = keep === "start" ? [...lines, hint] : [hint, ...lines];
      } else {
        this.cachedLines = lines;
      }
      this.cachedWidth = width;
    }
    return this.cachedLines;
  }
  invalidate() {
    this.cachedWidth = void 0;
    this.cachedLines = void 0;
  }
};

// package/dist/core/tools/truncate.js
var DEFAULT_MAX_LINES = 2e3;
var DEFAULT_MAX_BYTES = 50 * 1024;
function formatSize(bytes) {
  if (bytes < 1024) {
    return `${bytes}B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  } else {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
}

// package/dist/core/tools/renderers/bash.js
var BASH_PREVIEW_LINES = 5;
function formatShellCall(args, prompt) {
  const command = str(args?.command);
  const timeout = args?.timeout;
  const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
  const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
  return theme.fg("toolTitle", theme.bold(`${prompt} ${commandDisplay}`)) + timeoutSuffix;
}
function rebuildBashResultRenderComponent(component, result, options, showImages, timerText) {
  component.clear();
  let output = getTextOutput(result, showImages).trim();
  const truncation = result.details?.truncation;
  const fullOutputPath = result.details?.fullOutputPath;
  if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
    const footerStart = output.lastIndexOf("\n\n[");
    if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
      output = output.slice(0, footerStart).trimEnd();
    }
  }
  if (output) {
    const styledOutput = output.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n");
    if (options.expanded) {
      component.addChild(new Text4(`
${styledOutput}`, 0, 0));
    } else {
      component.addChild(new Spacer3(1));
      component.addChild(new VisualLinePreview({
        text: styledOutput,
        maxVisualLines: BASH_PREVIEW_LINES,
        keep: "end",
        formatHint: (hidden) => theme.fg("muted", `... (${hidden} earlier lines,`) + ` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`
      }));
    }
  }
  if (truncation?.truncated || fullOutputPath) {
    const warnings = [];
    if (fullOutputPath) {
      warnings.push(`Full output: ${fullOutputPath}`);
    }
    if (truncation?.truncated) {
      if (truncation.truncatedBy === "lines") {
        warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
      } else {
        warnings.push(`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`);
      }
    }
    component.addChild(new Text4(`
${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
  }
  if (timerText)
    component.addChild(new Text4(`
${theme.fg("muted", timerText)}`, 0, 0));
}
function createShellRenderers(prompt) {
  return {
    renderCall(args, _theme, context) {
      startToolTimer(context);
      const text = context.lastComponent ?? new Text4("", 0, 0);
      text.setText(formatShellCall(args, prompt));
      return text;
    },
    renderResult(result, options, _theme, context) {
      const timerText = toolTimerText(context, options.isPartial);
      const component = context.lastComponent ?? new Container4();
      rebuildBashResultRenderComponent(component, result, options, context.showImages, timerText);
      component.invalidate();
      return component;
    }
  };
}

// package/dist/core/tools/renderers/read.js
import { basename, dirname, isAbsolute as isAbsolute2, relative as relative2, resolve as resolvePath2, sep as sep2 } from "node:path";
import { Text as Text5 } from "@earendil-works/pi-tui";

// package/dist/core/tools/path-utils.js
function resolveToCwd(filePath, cwd) {
  return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

// package/dist/core/tools/renderers/read.js
var COMPACT_RESOURCE_FILE_NAMES = /* @__PURE__ */ new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
function styledReadLineRange(args, theme2) {
  const range = formatReadLineRange(args?.offset, args?.limit);
  return range ? theme2.fg("warning", range) : "";
}
function formatReadCall(args, theme2, cwd) {
  const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme2, cwd);
  return `${theme2.fg("toolTitle", theme2.bold("read"))} ${pathDisplay}${styledReadLineRange(args, theme2)}`;
}
function trimTrailingEmptyLines(lines) {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") {
    end--;
  }
  return lines.slice(0, end);
}
function toPosixPath(filePath) {
  return filePath.split(sep2).join("/");
}
function getPiDocsClassification(absolutePath) {
  const packageRoot = dirname(getReadmePath());
  const relativePath = relative2(resolvePath2(packageRoot), resolvePath2(absolutePath));
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep2}`) || isAbsolute2(relativePath)) {
    return void 0;
  }
  const label = toPosixPath(relativePath);
  if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
    return { kind: "docs", label };
  }
  return void 0;
}
function getCompactReadClassification(args, cwd) {
  const rawPath = str(args?.file_path ?? args?.path);
  if (!rawPath)
    return void 0;
  const absolutePath = resolveToCwd(rawPath, cwd);
  const fileName = basename(absolutePath);
  if (fileName === "SKILL.md") {
    return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
  }
  const docsClassification = getPiDocsClassification(absolutePath);
  if (docsClassification)
    return docsClassification;
  if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
    return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
  }
  return void 0;
}
function formatCompactReadCall(classification, args, theme2) {
  const expandHint = theme2.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
  if (classification.kind === "skill") {
    return theme2.fg("customMessageLabel", `\x1B[1m[skill]\x1B[22m `) + theme2.fg("customMessageText", classification.label) + styledReadLineRange(args, theme2) + expandHint;
  }
  return theme2.fg("toolTitle", theme2.bold(`read ${classification.kind}`)) + " " + theme2.fg("accent", classification.label) + styledReadLineRange(args, theme2) + expandHint;
}
function formatReadResult(args, result, options, theme2, showImages, _cwd, isError) {
  if (!options.expanded && !isError) {
    return "";
  }
  const rawPath = str(args?.file_path ?? args?.path);
  const output = getTextOutput(result, showImages);
  const lang = !isError && rawPath ? getLanguageFromPath(rawPath) : void 0;
  const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
  const lines = trimTrailingEmptyLines(renderedLines);
  const maxLines = options.expanded ? lines.length : 10;
  const displayLines = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  let text = `
${displayLines.map((line) => lang ? replaceTabs(line) : theme2.fg("toolOutput", replaceTabs(line))).join("\n")}`;
  if (remaining > 0) {
    text += `${theme2.fg("muted", `
... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme2.fg("muted", ")")}`;
  }
  const truncation = result.details?.truncation;
  if (truncation?.truncated) {
    if (truncation.firstLineExceedsLimit) {
      text += `
${theme2.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
    } else if (truncation.truncatedBy === "lines") {
      text += `
${theme2.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
    } else {
      text += `
${theme2.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
    }
  }
  return text;
}
var readRenderers = {
  renderCall(rawArgs, theme2, context) {
    const args = rawArgs;
    const text = context.lastComponent ?? new Text5("", 0, 0);
    const classification = !context.expanded ? getCompactReadClassification(args, context.cwd) : void 0;
    text.setText(classification ? formatCompactReadCall(classification, args, theme2) : formatReadCall(args, theme2, context.cwd));
    return text;
  },
  renderResult(result, options, theme2, context) {
    const text = context.lastComponent ?? new Text5("", 0, 0);
    text.setText(formatReadResult(context.args, result, options, theme2, context.showImages, context.cwd, context.isError));
    return text;
  }
};

// package/dist/core/tools/renderers/write.js
import { Container as Container5, Text as Text6 } from "@earendil-works/pi-tui";
var WriteCallRenderComponent = class extends Text6 {
  cache;
  constructor() {
    super("", 0, 0);
  }
};
var WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;
function highlightSingleLine(line, lang) {
  const highlighted = highlightCode(line, lang);
  return highlighted[0] ?? "";
}
function refreshWriteHighlightPrefix(cache) {
  const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
  if (prefixCount === 0)
    return;
  const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
  const prefixHighlighted = highlightCode(prefixSource, cache.lang);
  for (let i = 0; i < prefixCount; i++) {
    cache.highlightedLines[i] = prefixHighlighted[i] ?? highlightSingleLine(cache.normalizedLines[i] ?? "", cache.lang);
  }
}
function rebuildWriteHighlightCacheFull(rawPath, fileContent) {
  const lang = rawPath ? getLanguageFromPath(rawPath) : void 0;
  if (!lang)
    return void 0;
  const displayContent = normalizeDisplayText(fileContent);
  const normalized = replaceTabs(displayContent);
  return {
    rawPath,
    lang,
    rawContent: fileContent,
    normalizedLines: normalized.split("\n"),
    highlightedLines: highlightCode(normalized, lang)
  };
}
function updateWriteHighlightCacheIncremental(cache, rawPath, fileContent) {
  const lang = rawPath ? getLanguageFromPath(rawPath) : void 0;
  if (!lang)
    return void 0;
  if (!cache)
    return rebuildWriteHighlightCacheFull(rawPath, fileContent);
  if (cache.lang !== lang || cache.rawPath !== rawPath)
    return rebuildWriteHighlightCacheFull(rawPath, fileContent);
  if (!fileContent.startsWith(cache.rawContent))
    return rebuildWriteHighlightCacheFull(rawPath, fileContent);
  if (fileContent.length === cache.rawContent.length)
    return cache;
  const deltaRaw = fileContent.slice(cache.rawContent.length);
  const deltaDisplay = normalizeDisplayText(deltaRaw);
  const deltaNormalized = replaceTabs(deltaDisplay);
  cache.rawContent = fileContent;
  if (cache.normalizedLines.length === 0) {
    cache.normalizedLines.push("");
    cache.highlightedLines.push("");
  }
  const segments = deltaNormalized.split("\n");
  const lastIndex = cache.normalizedLines.length - 1;
  cache.normalizedLines[lastIndex] += segments[0];
  cache.highlightedLines[lastIndex] = highlightSingleLine(cache.normalizedLines[lastIndex], cache.lang);
  for (let i = 1; i < segments.length; i++) {
    cache.normalizedLines.push(segments[i]);
    cache.highlightedLines.push(highlightSingleLine(segments[i], cache.lang));
  }
  refreshWriteHighlightPrefix(cache);
  return cache;
}
function trimTrailingEmptyLines2(lines) {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") {
    end--;
  }
  return lines.slice(0, end);
}
function formatWriteCall(args, options, theme2, cache, cwd) {
  const rawPath = str(args?.file_path ?? args?.path);
  const fileContent = str(args?.content);
  const pathDisplay = renderToolPath(rawPath, theme2, cwd);
  let text = `${theme2.fg("toolTitle", theme2.bold("write"))} ${pathDisplay}`;
  if (fileContent === null) {
    text += `

${theme2.fg("error", "[invalid content arg - expected string]")}`;
  } else if (fileContent) {
    const lang = rawPath ? getLanguageFromPath(rawPath) : void 0;
    const renderedLines = lang ? cache?.highlightedLines ?? highlightCode(replaceTabs(normalizeDisplayText(fileContent)), lang) : normalizeDisplayText(fileContent).split("\n");
    const lines = trimTrailingEmptyLines2(renderedLines);
    const totalLines = lines.length;
    const maxLines = options.expanded ? lines.length : 10;
    const displayLines = lines.slice(0, maxLines);
    const remaining = lines.length - maxLines;
    text += `

${displayLines.map((line) => lang ? line : theme2.fg("toolOutput", replaceTabs(line))).join("\n")}`;
    if (remaining > 0) {
      text += `${theme2.fg("muted", `
... (${remaining} more lines, ${totalLines} total,`)} ${keyHint("app.tools.expand", "to expand")}${theme2.fg("muted", ")")}`;
    }
  }
  return text;
}
function formatWriteResult(result, theme2) {
  if (!result.isError) {
    return void 0;
  }
  const output = result.content.filter((c2) => c2.type === "text").map((c2) => c2.text || "").join("\n");
  if (!output) {
    return void 0;
  }
  return `
${theme2.fg("error", output)}`;
}
var writeRenderers = {
  renderCall(args, theme2, context) {
    const renderArgs = args;
    const rawPath = str(renderArgs?.file_path ?? renderArgs?.path);
    const fileContent = str(renderArgs?.content);
    const component = context.lastComponent ?? new WriteCallRenderComponent();
    if (fileContent !== null) {
      component.cache = context.argsComplete ? rebuildWriteHighlightCacheFull(rawPath, fileContent) : updateWriteHighlightCacheIncremental(component.cache, rawPath, fileContent);
    } else {
      component.cache = void 0;
    }
    component.setText(formatWriteCall(renderArgs, { expanded: context.expanded, isPartial: context.isPartial }, theme2, component.cache, context.cwd));
    return component;
  },
  renderResult(result, _options, theme2, context) {
    const output = formatWriteResult({ ...result, isError: context.isError }, theme2);
    if (!output) {
      const component = context.lastComponent ?? new Container5();
      component.clear();
      return component;
    }
    const text = context.lastComponent ?? new Text6("", 0, 0);
    text.setText(output);
    return text;
  }
};
export {
  AssistantMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  createShellRenderers,
  getMarkdownTheme,
  loadThemeFromPath,
  readRenderers,
  setThemeInstance,
  theme,
  writeRenderers
};
