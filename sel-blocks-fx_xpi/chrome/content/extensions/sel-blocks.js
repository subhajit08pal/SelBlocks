/*
 * SelBlocks 2.0b
 *
 * Provides commands for Javascript-like looping and callable functions,
 *   with scoped variables, and JSON/XML driven parameterization.
 *
 * (Selbock installs as a Core Extension, not an IDE Extension, because it manipulates the Selenium object)
 *
 * Features
 *  - Commands: if/else, try/catch/finally, for/foreach/while, call/function/return,
 *    loadJsonVars/loadXmlVars, forJson/forXml
 *  - Function and loop parameters create regular Selenium variables that are local to the block,
 *    overriding variables of the same name, and that are restored when the block exits.
 *  - Variables can be set via external JSON/XML data file(s).
 *  - Command parameters are Javascript expressions that are evaluated with Selenium variables
 *    in scope, which can therefore be referenced by their simple names, e.g.: i+1
 *  - A function definition can appear anywhere; they are skipped over in normal execution flow.
 *  - Functions can be invoked recursively.
 *
 * Concept of operation:
 *  - Selenium.reset() is intercepted to initialize the block structures.
 *  - testCase.nextCommand() is overridden for flow branching.
 *  - TestLoop.resume() is overridden by exitTest, and by try/catch/finally to manage the outcome of errors.
 *  - The static structure of command blocks is stored in blockDefs[] by script line number.
 *    E.g., ifDef has pointers to its corresponding elseIf, else, endIf commands.
 *  - The state of each function-call is pushed/popped on callStack as it begins/ends execution
 *    The state of each block is pushed/popped on the blockStack as it begins/ends execution.
 *    An independent blockStack is associated with each function-call. I.e., stacks stored on a stack.
 *    (Non-block commands do not appear on the blockStack.)
 *
 * Limitations:
 *  - Incompatible with flowControl (and derivatives), because they unilaterally override selenium.reset().
 *    Known to have this issue:
 *      selenium_ide__flow_control
 *      goto_while_for_ide
 *
 * Acknowledgements:
 *  SelBlocks reuses bits & parts of extensions: flowControl, datadriven, and include.
 *
 * Wishlist:
 *  - validation of JSON & XML input files
 *
 * Changes since 1.5:
 *  - added try/catch/finally
 *  - added elseIf command
 *  - added exitTest command
 *  - block boundaries enforced (jumping in-to/out-of the middle of blocks)
 *  - function/endFunction replaces script/endScript
 *
 * NOTE - The Stored Variables Viewer addon will display the values of Selblocks parameters,
 *   because they are implemented as regular Selenium variables.
 *   The only thing special about Selblocks parameters is that they are activated and deactivated
 *   as script execution flows into and out of blocks, eg, for/endFor, function/endFunction, etc.
 *   So this can provide a convenient way to monitor the progress of an executing script.
 */


// =============== global functions as script helpers ===============
// getEval script helpers

// Find an element via locator independent of any selenium commands
// (findElementOrNull returns the first if there are multiple matches)
function $e(locator) {
  return selblocks.unwrapObject(selenium.browserbot.findElementOrNull(locator));
}

// Return the singular XPath result as a value of the appropriate type
function $x(xpath, contextNode, resultType) {
  var doc = selenium.browserbot.getDocument();
  var node;
  if (resultType)
    node = selblocks.xp.selectNode(doc, xpath, contextNode, resultType); // mozilla engine only
  else
    node = selblocks.xp.selectElement(doc, xpath, contextNode);
  return node;
}

// Return the XPath result set as an array of elements
function $X(xpath, contextNode, resultType) {
  var doc = selenium.browserbot.getDocument();
  var nodes;
  if (resultType)
    nodes = selblocks.xp.selectNodes(doc, xpath, contextNode, resultType); // mozilla engine only
  else
    nodes = selblocks.xp.selectElements(doc, xpath, contextNode);
  return nodes;
}

// selbocks name-space
(function($$){

  // =============== Javascript extensions as script helpers ===============

  // eg: "dilbert".isOneOf("dilbert","dogbert","mordac") => true
  String.prototype.isOneOf = function(values)
  {
    if (!(values instanceof Array)) // copy function arguments into an array
      values = Array.prototype.slice.call(arguments);
    for (var i = 0; i < this.length; i++) {
      if (values[i] == this) {
        return true;
      }
    }
    return false;
  };

  // eg: "red".mapTo("primary", ["red","green","blue"]) => primary
  String.prototype.mapTo = function(/* pairs of: string, array */)
  {
    var errMsg = " The map function requires pairs of argument: string, array";
    assert(arguments.length % 2 == 0, errMsg + "; found " + arguments.length);
    for (var i = 0; i < arguments.length; i += 2) {
      assert((typeof arguments[i].toLowerCase() == "string") && (arguments[i+1] instanceof Array),
        errMsg + "; found " + typeof arguments[i] + ", " + typeof arguments[i+1]);
      if (this.isOneOf(arguments[i+1])) {
        return arguments[i];
      }
    }
    return this;
  };

  // produce an iterator object for the given array
  Array.prototype.iterator = function() {
    return new function(ary) {
      var cur = 0;
      this.hasNext = function() { return (cur < ary.length); };
      this.next = function() { if (this.hasNext()) return ary[cur++]; };
    }(this);
  };


  //=============== Call/Scope Stack handling ===============

  var symbols = {};      // command indexes stored by name: function names
  var blockDefs = null;  // static command definitions stored by command index
  var callStack = null;  // command execution stack

  // the idx of the currently executing command
  function idxHere() {
    return testCase.debugContext.debugIndex;
  }

  // Command structure definitions, stored by command index
  function BlockDefs() {
    var cmds = [];
    // initialize blockDef at the given command index
    cmds.init = function(i, attrs) {
      cmds[i] = attrs || {};
      cmds[i].idx = i;
      cmds[i].cmdName = testCase.commands[i].command;
      return cmds[i];
    };
    // retrieve the blockDef for the currently executing command
    cmds.here = function() {
      var curIdx = idxHere();
      if (!cmds[curIdx])
        $$.LOG.warn("No blockDef defined at curIdx=" + curIdx);
      return cmds[curIdx];
    };
    return cmds;
  }

  // An Array object with stack functionality
  function Stack() {
    var stack = [];
    stack.isEmpty = function() { return stack.length == 0; };
    stack.top = function()     { return stack[stack.length-1]; };
    stack.findEnclosing = function(_hasCriteria) { return stack[stack.indexWhere(_hasCriteria)]; };
    stack.indexWhere = function(_hasCriteria) { // undefined if not found
      for (var i = stack.length-1; i >= 0; i--) {
        if (_hasCriteria(stack[i]))
          return i;
      }
    };
    stack.unwindTo = function(_hasCriteria) {
      if (stack.length == 0)
        return null;
      while (!_hasCriteria(stack.top()))
        stack.pop();
      return stack.top();
    };
    stack.isHere = function() {
      return (stack.length > 0 && stack.top().idx == idxHere());
    };
    return stack;
  }

  // Determine if the given stack frame is one of the given block kinds
  Stack.isLoopBlock = function(stackFrame) {
    return (blockDefs[stackFrame.idx].nature == "loop");
  };
  Stack.isFunctionBlock = function(stackFrame) {
    return (blockDefs[stackFrame.idx].nature == "function");
  };


  // Flow control - we don't just alter debugIndex on the fly, because the command
  // preceding the destination would falsely get marked as successfully executed
  var branchIdx = null;
  // if testCase.nextCommand() ever changes, this will need to be revisited
  // (current as of: selenium-ide-2.4.0)
  function nextCommand() {
    if (!this.started) {
      this.started = true;
      this.debugIndex = testCase.startPoint ? testCase.commands.indexOf(testCase.startPoint) : 0;
    }
    else {
      if (branchIdx != null) {
        $$.LOG.info("branch => " + fmtCmdRef(branchIdx));
        this.debugIndex = branchIdx;
        branchIdx = null;
      }
      else
        this.debugIndex++;
    }
    // skip over comments
    for (; this.debugIndex < testCase.commands.length; this.debugIndex++) {
      var command = testCase.commands[this.debugIndex];
      if (command.type == "command") {
        return command;
      }
    }
    return null;
  }
  function setNextCommand(cmdIdx) {
    assert(cmdIdx >= 0 && cmdIdx < testCase.commands.length,
      " Cannot branch to non-existent command @" + (cmdIdx+1));
    branchIdx = cmdIdx;
  }

  // Selenium calls reset():
  //  * before each single (double-click) command execution
  //  * before a testcase is run
  //  * before each testcase runs in a running testsuite
  // TBD: skip during single command execution
  $$.fn.interceptAfter(Selenium.prototype, "reset", function()
  {
    $$.LOG.trace("In tail intercept :: Selenium.reset()");
    try {
      compileSelBlocks();
    } catch (err) {
      notifyFatalErr("In " + err.fileName + " @" + err.lineNumber + ": " + err);
    }
    callStack = new Stack();
    callStack.push({ blockStack: new Stack() }); // top-level execution state

    $$.tcf = { nestingLevel: -1 };

    // customize flow control logic
    // TBD: this should be a tail intercept rather than brute force replace
    $$.LOG.debug("Configuring tail intercept: testCase.debugContext.nextCommand()");
    $$.fn.interceptReplace(testCase.debugContext, "nextCommand", nextCommand);
  });

  // get the blockStack for the currently active callStack
  function activeBlockStack() {
    return callStack.top().blockStack;
  }

  // ================================================================================
  // Assemble block relationships and symbol locations
  function compileSelBlocks()
  {
    blockDefs = new BlockDefs();
    var lexStack = new Stack();
    for (var i = 0; i < testCase.commands.length; i++)
    {
      if (testCase.commands[i].type == "command")
      {
        var curCmd = testCase.commands[i].command;
        var aw = curCmd.indexOf("AndWait");
        if (aw != -1) {
          // just ignore the suffix for now, this may or may not be a Selblocks commands
          curCmd = curCmd.substring(0, aw);
        }
        var cmdTarget = testCase.commands[i].target;

        switch(curCmd)
        {
          case "label":
            assertNotAndWaitSuffix(i);
            symbols[cmdTarget] = i;
            break;
          case "goto": case "gotoIf": case "skipNext":
            assertNotAndWaitSuffix(i);
            break;

          case "if":
            assertNotAndWaitSuffix(i);
            lexStack.push(blockDefs.init(i, { nature: "if", elseIfIdxs: [] }));
            break;
          case "elseIf":
            assertNotAndWaitSuffix(i);
            assertBlockIsPending("elseIf", i, ", is not valid outside of an if/endIf block");
            var ifDef = lexStack.top();
            assertMatching(ifDef.cmdName, "if", i, ifDef.idx);
            var eIdx = blockDefs[ifDef.idx].elseIdx;
            if (eIdx)
              notifyFatal(fmtCmdRef(eIdx) + " An else has to come after all elseIfs.");
            blockDefs.init(i, { ifIdx: ifDef.idx });       // elseIf -> if
            blockDefs[ifDef.idx].elseIfIdxs.push(i);       // if -> elseIf(s)
            break;
          case "else":
            assertNotAndWaitSuffix(i);
            assertBlockIsPending("if", i, ", is not valid outside of an if/endIf block");
            var ifDef = lexStack.top();
            assertMatching(ifDef.cmdName, "if", i, ifDef.idx);
            if (blockDefs[ifDef.idx].elseIdx)
              notifyFatal(fmtCmdRef(i) + " There can only be one else associated with a given if.");
            blockDefs.init(i, { ifIdx: ifDef.idx });       // else -> if
            blockDefs[ifDef.idx].elseIdx = i;              // if -> else
            break;
          case "endIf":
            assertNotAndWaitSuffix(i);
            assertBlockIsPending("if", i);
            var ifDef = lexStack.pop();
            assertMatching(ifDef.cmdName, "if", i, ifDef.idx);
            blockDefs.init(i, { ifIdx: ifDef.idx });       // endIf -> if
            blockDefs[ifDef.idx].endIdx = i;               // if -> endif
            if (ifDef.elseIdx)
              blockDefs[ifDef.elseIdx].endIdx = i;         // else -> endif
            break;

          case "try":
            assertNotAndWaitSuffix(i);
            lexStack.push(blockDefs.init(i, { nature: "try", name: cmdTarget }));
            break;
          case "catch":
            assertNotAndWaitSuffix(i);
            assertBlockIsPending("try", i, ", is not valid without a try block");
            var tryDef = lexStack.top();
            assertMatching(tryDef.cmdName, "try", i, tryDef.idx);
            if (blockDefs[tryDef.idx].catchIdx)
              notifyFatal(fmtCmdRef(i) + " There can only be one catch-block associated with a given try.");
            var fIdx = blockDefs[tryDef.idx].finallyIdx;
            if (fIdx)
              notifyFatal(fmtCmdRef(fIdx) + " A finally-block has to be last in a try section.");
            blockDefs.init(i, { tryIdx: tryDef.idx });     // catch -> try
            blockDefs[tryDef.idx].catchIdx = i;            // try -> catch
            break;
          case "finally":
            assertNotAndWaitSuffix(i);
            assertBlockIsPending("try", i);
            var tryDef = lexStack.top();
            assertMatching(tryDef.cmdName, "try", i, tryDef.idx);
            if (blockDefs[tryDef.idx].finallyIdx)
              notifyFatal(fmtCmdRef(i) + " There can only be one finally-block associated with a given try.");
            blockDefs.init(i, { tryIdx: tryDef.idx });     // finally -> try
            blockDefs[tryDef.idx].finallyIdx = i;          // try -> finally
            if (tryDef.catchIdx)
              blockDefs[tryDef.catchIdx].finallyIdx = i;   // catch -> finally
            break;
          case "endTry":
            assertNotAndWaitSuffix(i);
            assertBlockIsPending("try", i);
            var tryDef = lexStack.pop();
            assertMatching(tryDef.cmdName, "try", i, tryDef.idx);
            if (cmdTarget)
              assertMatching(tryDef.name, cmdTarget, i, tryDef.idx); // pair-up on try-name
            blockDefs.init(i, { tryIdx: tryDef.idx });     // endTry -> try
            blockDefs[tryDef.idx].endIdx = i;              // try -> endTry
            if (tryDef.catchIdx)
              blockDefs[tryDef.catchIdx].endIdx = i;       // catch -> endTry
            break;

          case "while":    case "for":    case "foreach":    case "forJson":    case "forXml":
            assertNotAndWaitSuffix(i);
            lexStack.push(blockDefs.init(i, { nature: "loop" }));
            break;
          case "continue": case "break":
            assertNotAndWaitSuffix(i);
            assertCmd(i, lexStack.findEnclosing(Stack.isLoopBlock), ", is not valid outside of a loop");
            blockDefs.init(i, { beginIdx: lexStack.top().idx }); // -> begin
            break;
          case "endWhile": case "endFor": case "endForeach": case "endForJson": case "endForXml":
            assertNotAndWaitSuffix(i);
            var expectedCmd = curCmd.substr(3).toLowerCase();
            assertBlockIsPending(expectedCmd, i);
            var beginDef = lexStack.pop();
            assertMatching(beginDef.cmdName.toLowerCase(), expectedCmd, i, beginDef.idx);
            blockDefs[beginDef.idx].endIdx = i;            // begin -> end
            blockDefs.init(i, { beginIdx: beginDef.idx }); // end -> begin
            break;

          case "loadJsonVars": case "loadXmlVars":
            assertNotAndWaitSuffix(i);
            break;

          case "call":
            assertNotAndWaitSuffix(i);
            blockDefs.init(i);
            break;
          case "function":     case "script":
            assertNotAndWaitSuffix(i);
            symbols[cmdTarget] = i;
            lexStack.push(blockDefs.init(i, { nature: "function", name: cmdTarget }));
            break;
          case "return":
            assertNotAndWaitSuffix(i);
            assertBlockIsPending("function", i, ", is not valid outside of a function/endFunction block");
            var funcCmd = lexStack.findEnclosing(Stack.isFunctionBlock);
            blockDefs.init(i, { funcIdx: funcCmd.idx });   // return -> function
            break;
          case "endFunction":  case "endScript":
            assertNotAndWaitSuffix(i);
            var expectedCmd = curCmd.substr(3).toLowerCase();
            assertBlockIsPending(expectedCmd, i);
            var funcDef = lexStack.pop();
            assertMatching(funcDef.cmdName.toLowerCase(), expectedCmd, i, funcDef.idx);
            if (cmdTarget)
              assertMatching(funcDef.name, cmdTarget, i, funcDef.idx); // pair-up on function name
            blockDefs[funcDef.idx].endIdx = i;             // function -> endFunction
            blockDefs.init(i, { funcIdx: funcDef.idx });   // endFunction -> function
            break;

          case "exitTest":
            assertNotAndWaitSuffix(i);
            break;
          default:
        }
      }
    }
    while (!lexStack.isEmpty()) {
      // unterminated block(s)
      var pend = lexStack.pop();
      var expectedCmd = "end" + pend.cmdName.substr(0, 1).toUpperCase() + pend.cmdName.substr(1);
      throw new Error(fmtCmdRef(pend.idx) + ", without a terminating [" + expectedCmd + "]");
    }
    //- command validation
    function assertNotAndWaitSuffix(cmdIdx) {
      assertCmd(cmdIdx, (testCase.commands[cmdIdx].command.indexOf("AndWait") == -1),
        ", AndWait suffix is not valid for Selblocks commands");
    }
    //- active block validation
    function assertBlockIsPending(expectedCmd, cmdIdx, desc) {
      assertCmd(cmdIdx, !lexStack.isEmpty(), desc || ", without an beginning [" + expectedCmd + "]");
    }
    //- command-pairing validation
    function assertMatching(curCmd, expectedCmd, cmdIdx, pendIdx) {
      assertCmd(cmdIdx, curCmd == expectedCmd, ", does not match command " + fmtCmdRef(pendIdx));
    }
  }

  // --------------------------------------------------------------------------------

  function assertIntraBlockJumpRestriction(fromIdx, toIdx) {
    var fromRange = findBlockRange(fromIdx);
    var toRange   = findBlockRange(toIdx);
    if (fromRange || toRange) {
      var msg = " Attempt to jump";
      if (fromRange) msg += " out of " + fromRange.desc + fromRange.fmt();
      if (toRange)   msg += " into " + toRange.desc + toRange.fmt();
      assert(fromRange && fromRange.equals(toRange), msg 
        + ". You cannot jump into, or out of: loops, functions, or try blocks.");
    }
  }

  function findBlockRange(locusIdx) {
    for (var idx = locusIdx-1; idx >= 0; idx--) {
      var blk = blockDefs[idx];
      if (blk) {
        if (locusIdx > blk.endIdx) // ignore blocks that are inside this block
          continue;
        switch (blk.nature) {
          case "loop":     return new CmdRange(blk.idx, blk.endIdx, blk.cmdName + " loop");
          case "function": return new CmdRange(blk.idx, blk.endIdx, "function '" + blk.name + "'");
          case "try":      return isolateTcfRange(locusIdx, blk);
        }
      }
    }
    // return as undefined (no enclosing block at all)
  }

  function isolateTcfRange(idx, tryDef) {
    // assumption: idx known to be between try & endTry, and a catch always precedes a finally
    var RANGES = [
      { ifr: tryDef.finallyIdx, ito: tryDef.endIdx,     desc: "finally", desc2: "end" }
     ,{ ifr: tryDef.catchIdx,   ito: tryDef.finallyIdx, desc: "catch",   desc2: "finally" }
     ,{ ifr: tryDef.catchIdx,   ito: tryDef.endIdx,     desc: "catch",   desc2: "end" }
     ,{ ifr: tryDef.idx,        ito: tryDef.catchIdx,   desc: "try",     desc2: "catch" }
     ,{ ifr: tryDef.idx,        ito: tryDef.finallyIdx, desc: "try",     desc2: "finally" }
     ,{ ifr: tryDef.idx,        ito: tryDef.endIdx,     desc: "try",     desc2: "end" }
    ];
    for (var i = 0; i < RANGES.length; i++) {
      var rng = RANGES[i];
      if (rng.ifr <= idx && idx < rng.ito) {
        var desc = rng.desc + "-block";
        if (rng.desc != "try") desc += " for";
        if (tryDef.name) desc += " '" + tryDef.name + "'";
        return cmdRange = new CmdRange(rng.ifr, rng.ito, desc);
      }
    }
  }
 
  function CmdRange(topIdx, bottomIdx, desc) {
    this.topIdx = topIdx;
    this.bottomIdx = bottomIdx;
    this.desc = desc;
    this.equals = function(cmdRange) {
      return (cmdRange && cmdRange.topIdx === this.topIdx && cmdRange.bottomIdx === this.bottomIdx);
    };
    this.fmt = function() {
      return " @[" + (this.topIdx+1) + "-" + (this.bottomIdx+1) + "]";
    };
  }

  // ==================== Selblocks Commands (Custom Selenium Actions) ====================

  var iexpr = Object.create($$.InfixExpressionParser);

  // validate variable/parameter names
  function validateNames(names, desc) {
    for (var i = 0; i < names.length; i++) {
      validateName(names[i], desc);
    }
  }
  function validateName(name, desc) {
    var match = name.match(/^[a-zA-Z]\w*$/);
    if (!match) {
      notifyFatal("Invalid character(s) in " + desc + " name: '" + name + "'");
    }
  }

  Selenium.prototype.doLabel = function() {
    // noop
  };

  // Skip the next N commands (default is 1)
  Selenium.prototype.doSkipNext = function(spec)
  {
    assertRunning();
    var n = parseInt(evalWithVars(spec), 10);
    if (isNaN(n)) {
      if (spec.trim() == "") n = 1;
      else notifyFatalHere(" Requires a numeric value");
    }
    else if (n < 0)
      notifyFatalHere(" Requires a number > 1");

    if (n != 0) { // if n=0, execute the next command as usual
      destIdx = idxHere() + n + 1;
      assertIntraBlockJumpRestriction(idxHere(), destIdx);
      setNextCommand(destIdx);
    }
  };

  Selenium.prototype.doGoto = function(label)
  {
    assertRunning();
    assert(symbols[label], " Target label '" + label + "' is not found.");
    assertIntraBlockJumpRestriction(idxHere(), symbols[label]);
    setNextCommand(symbols[label]);
  };

  Selenium.prototype.doGotoIf = function(condExpr, label)
  {
    assertRunning();
    if (evalWithVars(condExpr))
      this.doGoto(label);
  };

  // ================================================================================
  Selenium.prototype.doIf = function(condExpr, locator)
  {
    assertRunning();
    var ifDef = blockDefs.here();
    var ifState = { idx: idxHere(), elseIfItr: ifDef.elseIfIdxs.iterator() };
    activeBlockStack().push(ifState);
    cascadeElseIf(ifState, condExpr);
  };
  Selenium.prototype.doElseIf = function(condExpr)
  {
    assertRunning();
    assertActiveScope(blockDefs.here().ifIdx);
    var ifState = activeBlockStack().top();
    if (ifState.skipElseBlocks) // if, or previous elseIf, has already been met
      setNextCommand(blockDefs[blockDefs.here().ifIdx].endIdx);
    else
      cascadeElseIf(ifState, condExpr);
  };
  Selenium.prototype.doElse = function()
  {
    assertRunning();
    assertActiveScope(blockDefs.here().ifIdx);
    var ifState = activeBlockStack().top();
    if (ifState.skipElseBlocks) // if, or previous elseIf, has already been met
      setNextCommand(blockDefs.here().endIdx);
    // else continue into else-block
  };
  Selenium.prototype.doEndIf = function() {
    assertRunning();
    assertActiveScope(blockDefs.here().ifIdx);
    activeBlockStack().pop();
    // fall out of if-endIf
  };

  function cascadeElseIf(ifState, condExpr) {
    if (!evalWithVars(condExpr)) {
      // jump to next elseIf or else or endif
      var ifDef = blockDefs[ifState.idx];
      if (ifState.elseIfItr.hasNext()) setNextCommand(ifState.elseIfItr.next());
      else if (ifDef.elseIdx)          setNextCommand(ifDef.elseIdx);
      else                             setNextCommand(ifDef.endIdx);
    }
    else {
      ifState.skipElseBlocks = true;
      // continue into if/elseIf-block
    }
  }

  // ================================================================================

  // TBD: failed locators, timeouts, asserts
  Selenium.prototype.doTry = function(tryName)
  {
    assertRunning();
    var tryState = { idx: idxHere(), name: tryName };
    activeBlockStack().push(tryState);
    var tryDef = blockDefs.here();

    if (!tryDef.catchIdx && !tryDef.finallyIdx) {
      $$.LOG.warn(fmtCurCmd() + " does not have a catch-block nor a finally-block, and therefore serves no purpose");
      return; // continue into try-block without any special handling
    }

    // log an advisory about the active catch block
    if (tryDef.catchIdx) {
      var errDcl = testCase.commands[tryDef.catchIdx].target;
      $$.LOG.info(tryName + " catchable: " + (errDcl ? errDcl : "ANY"));
    }

    $$.tcf.nestingLevel++;
    tryState.execPhase = "trying";

    if ($$.tcf.nestingLevel == 0) {
      // enable special command handling
      $$.fn.interceptPush(editor.selDebugger.runner.IDETestLoop.prototype, "resume",
          $$.handleAsTryBlock, { handleError: handleCommandError });
    }
    $$.LOG.info("++ try nesting: " + $$.tcf.nestingLevel);
    // continue into try-block
  };

  Selenium.prototype.doCatch = function()
  {
    var tryState = assertTryBlock();
    if (tryState.execPhase != "catching") {
      // skip over unused catch-block
      var tryDef = blockDefs[tryState.idx];
      if (tryDef.finallyIdx)
        setNextCommand(tryDef.finallyIdx);
      else
        setNextCommand(tryDef.endIdx);
    }
    // else continue into catch-block
  };
  Selenium.prototype.doFinally = function() {
    var tryState = assertTryBlock();
    $$.LOG.info("entering finally block");
    // continue into finally-block
  };
  Selenium.prototype.doEndTry = function(tryName)
  {
    assertTryBlock();
    var tryState = activeBlockStack().pop();
    if (tryState.execPhase) { // ie, it does have a catch and/or a finally block
      $$.tcf.nestingLevel--;
      $$.LOG.info("-- try nesting: " + $$.tcf.nestingLevel);
      if ($$.tcf.nestingLevel < 0) {
        // discontinue try-block handling
        $$.fn.interceptPop();
      }
      if ($$.tcf.bubbling)
        reBubble();
      else
        $$.LOG.info("no bubbling in process");
    }
    var tryDef = blockDefs[tryState.idx];
    $$.LOG.info("end of try '" + tryDef.name + "'");
    // fall out of endTry
  };

  function assertTryBlock() {
    assertRunning();
    assertActiveScope(blockDefs.here().tryIdx);
    return activeBlockStack().top();
  }

  function reBubble() {
    if ($$.tcf.bubbling.mode == "error") {
      if ($$.tcf.nestingLevel > -1) {
        $$.LOG.info("error-bubbling continuing...");
        handleCommandError($$.tcf.bubbling.error);
      }
      else {
        $$.LOG.error("Error was not caught: " + $$.tcf.bubbling.error.message);
        try { throw $$.tcf.bubbling.error; }
        finally { $$.tcf.bubbling = null; }
      }
    }
    else { // mode == "command"
      if (isBubblable()) {
        $$.LOG.info("command-bubbling continuing...");
        bubbleCommand($$.tcf.bubbling.srcIdx, $$.tcf.bubbling._isStopCriteria);
      }
      else {
        $$.LOG.info("command-bubbling complete - suspended command executing now " + fmtCmdRef($$.tcf.bubbling.srcIdx));
        setNextCommand($$.tcf.bubbling.srcIdx);
        $$.tcf.bubbling = null;
      }
    }
  }

  // --------------------------------------------------------------------------------

  // alter the behavior of Selenium error handling
  function handleCommandError(err)
  {
    var tryState = bubbleToTryBlock(isTryBlock);
    var tryDef = blockDefs[tryState.idx];
    $$.LOG.info("Bubbling begins: " + fmtTry(tryState) + " : " + hasUnspentFinally(tryState));
    if (tryState.execPhase != "trying" && !hasUnspentFinally(tryState)) {
      $$.LOG.warn("No unspent finally block, ending this try section :: " + err.message);
      $$.tcf.bubbling = { mode: "error", error: err, srcIdx: idxHere() };
      setNextCommand(tryDef.endIdx);
      return true;
    }
    while (tryState) {
      $$.LOG.info("error encountered while: " + tryState.execPhase);
      if (hasUnspentCatch(tryState)) {
        var catchDcl = testCase.commands[tryDef.catchIdx].target;
        if (isMatchingError(err, catchDcl)) {
          // an expected kind of error has been caught
          $$.LOG.info("@" + (idxHere()+1) + ", error has been caught" + fmtCatching(tryState));
          tryState.hasCaught = true;
          tryState.execPhase = "catching";
          $$.tcf.bubbling = null;
          setNextCommand(tryDef.catchIdx);
          return true; // continue
        }
      }
      // error not caught .. instigate bubbling
      $$.LOG.info("error not caught, bubbling the error: " + err.message);
      $$.tcf.bubbling = { mode: "error", error: err, srcIdx: idxHere() };
      if (hasUnspentFinally(tryState)) {
        $$.LOG.warn("Bubbling suspended while finally block runs :: " + $$.tcf.bubbling.error.message);
        tryState.execPhase = "finallying";
        tryState.hasFinaled = true;
        setNextCommand(tryDef.finallyIdx);
        return true; // continue
      }
      tryState = bubbleToTryBlock(isTryWithCatchOrFinally);
      tryDef = blockDefs[tryState.idx];
    }
    // no matching catch and no finally to process
    return false; // halt the test

    //- error message matcher ----------
    function isMatchingError(e, errDcl) {
      if (!errDcl) {
        return true; // no error specified means catch all errors
      }
      var errExpr = evalWithVars(errDcl);
      var errMsg = e.message;
      if (errExpr instanceof RegExp) {
        return (errMsg.match(errExpr));
      }
      return (errMsg.indexOf(errExpr) != -1);
    }
  }

  // execute any enclosing finally block(s) until reaching the given type of block
  function bubbleCommand(cmdIdx, _isBubbleCeiling)
  {
    var tryState = bubbleToTryBlock(isTryWithFinally);
    while (tryState) {
      var tryDef = blockDefs[tryState.idx];
      $$.tcf.bubbling = { mode: "command", srcIdx: cmdIdx, _isStopCriteria: _isBubbleCeiling };
      if (hasUnspentFinally(tryState)) {
        $$.LOG.warn("Command " + fmtCmdRef(cmdIdx) + ", suspended while finally block runs");
        tryState.execPhase = "finallying";
        tryState.hasFinaled = true;
        setNextCommand(tryDef.finallyIdx);
        return;
      }
      tryState = bubbleToTryBlock(isTryWithFinally);
    }
    //- find enclosing finally-blocks, stopping at the given block type
    function isTryWithFinally(stackFrame) {
      return ( (blockDefs[stackFrame.idx].nature == "try" && hasUnspentFinally(stackFrame))
        || (_isBubbleCeiling ? _isBubbleCeiling(stackFrame) : false)
      );
    }
  }

  // unwind the blockStack, and callStack, until reaching the given criteria
  function bubbleToTryBlock(_hasCriteria) {
    if ($$.tcf.nestingLevel < 0)
      $$.LOG.error("bubbleToTryBlock() called outside of any try nesting");
    var tryState = unwindToBlock(_hasCriteria);
    while (!tryState && $$.tcf.nestingLevel > -1 && callStack.length > 1) {
      var callFrame = callStack.pop();
      $$.LOG.info("function '" + callFrame.name + "' aborting due to error");
      restoreVarState(callFrame.savedVars);
      tryState = unwindToBlock(_hasCriteria);
    }
    return tryState;
  }

  // unwind the blockStack until reaching the given criteria
  function unwindToBlock(_hasCriteria) {
    var tryState = activeBlockStack().unwindTo(_hasCriteria);
    if (tryState)
      $$.LOG.info("unwound to: " + fmtTry(tryState));
    return tryState;
  }

  // instigate or continue bubbling, if appropriate
  function transitionBubbling(_isBubbleCeiling)
  {
    if ($$.tcf.bubbling) { // transform bubbling
      if ($$.tcf.bubbling.mode == "error") {
        $$.LOG.warn("Bubbling error: " + $$.tcf.bubbling.error.message
          + ", replaced with command " + fmtCmdRef(idxHere()));
        $$.tcf.bubbling = { mode: "command", srcIdx: idxHere(), _isStopCriteria: _isBubbleCeiling };
        return true;
      }
      else { // mode == "command"
        $$.LOG.warn("Command suspension " + fmtCmdRef($$.tcf.bubbling.srcIdx)
          + ", replaced with " + fmtCmdRef(idxHere()));
        $$.tcf.bubbling.srcIdx = idxHere();
        return true;
      }
    }
    if (isBubblable()) { // instigate bubbling
      bubbleCommand(idxHere(), _isBubbleCeiling);
      return true;
    }
    return false;
  };

  function isBubblable() {
    var canBubble = ($$.tcf.nestingLevel > -1);
    if (canBubble) {
      var blk = activeBlockStack().top();
      if (blk)
        canBubble = (blk.execPhase != "finallying");
    }
    return canBubble;
  }

  function isTryBlock(stackFrame) {
    return (blockDefs[stackFrame.idx].nature == "try");
  }
  function isTryWithCatchOrFinally(stackFrame) {
    return ( blockDefs[stackFrame.idx].nature == "try" && hasUnspentCatchOrFinally(stackFrame) );
  }
  function hasUnspentCatchOrFinally(tryState) {
    return (hasUnspentCatch(tryState) || hasUnspentFinally(tryState));
  }
  function hasUnspentCatch(tryState) {
    return (blockDefs[tryState.idx].catchIdx && !tryState.hasCaught);
  }
  function hasUnspentFinally(tryState) {
    return (blockDefs[tryState.idx].finallyIdx && !tryState.hasFinaled);
  }

  function fmtTry(tryState)
  {
    var tryDef = blockDefs[tryState.idx];
    return (
      (tryDef.name ? "try '" + tryDef.name + "' " : "")
      + "@" + (tryState.idx+1)
      + ", " + tryState.execPhase + ".."
      + " " + $$.tcf.nestingLevel + "n"
    );
  }

  function fmtCatching(tryState)
  {
    if (!tryState)
      return "";
    var bbl = "";
    if ($$.tcf.bubbling)
      bbl = "@" + ($$.tcf.bubbling.srcIdx+1) + " ";
    var tryDef = blockDefs[tryState.idx];
    var catchDcl = testCase.commands[tryDef.catchIdx].target;
    return " :: " + bbl + catchDcl;
  }

  // ================================================================================
  Selenium.prototype.doWhile = function(condExpr)
  {
    enterLoop(
      function() {    // validate
          assert(condExpr, " 'while' requires a condition expression.");
          return null;
      }
      ,function() { } // initialize
      ,function() { return (evalWithVars(condExpr)); } // continue?
      ,function() { } // iterate
    );
  };
  Selenium.prototype.doEndWhile = function() {
    iterateLoop();
  };

  // ================================================================================
  Selenium.prototype.doFor = function(forSpec, localVarsSpec)
  {
    enterLoop(
      function(loop) { // validate
          assert(forSpec, " 'for' requires: <initial-val>; <condition>; <iter-stmt>.");
          var specs = iexpr.splitList(forSpec, ";");
          assert(specs.length == 3, " 'for' requires <init-stmt>; <condition>; <iter-stmt>.");
          loop.initStmt = specs[0];
          loop.condExpr = specs[1];
          loop.iterStmt = specs[2];
          var localVarNames = [];
          if (localVarsSpec) {
            localVarNames = iexpr.splitList(localVarsSpec, ",");
            validateNames(localVarNames, "variable");
          }
          return localVarNames;
      }
      ,function(loop) { evalWithVars(loop.initStmt); }          // initialize
      ,function(loop) { return (evalWithVars(loop.condExpr)); } // continue?
      ,function(loop) { evalWithVars(loop.iterStmt); }          // iterate
    );
  };
  Selenium.prototype.doEndFor = function() {
    iterateLoop();
  };

  // ================================================================================
  Selenium.prototype.doForeach = function(varName, valueExpr)
  {
    enterLoop(
      function(loop) { // validate
          assert(varName, " 'foreach' requires a variable name.");
          assert(valueExpr, " 'foreach' requires comma-separated values.");
          loop.values = evalWithVars("[" + valueExpr + "]");
          if (loop.values.length == 1 && loop.values[0] instanceof Array) {
            loop.values = loop.values[0]; // if sole element is an array, than use it
          }
          return [varName, "_i"];
      }
      ,function(loop) { loop.i = 0; storedVars[varName] = loop.values[loop.i]; }       // initialize
      ,function(loop) { storedVars._i = loop.i; return (loop.i < loop.values.length);} // continue?
      ,function(loop) { // iterate
          if (++(loop.i) < loop.values.length)
            storedVars[varName] = loop.values[loop.i];
      }
    );
  };
  Selenium.prototype.doEndForeach = function() {
    iterateLoop();
  };

  // ================================================================================
  Selenium.prototype.doLoadJsonVars = function(filepath, selector)
  {
    assert(filepath, " Requires a JSON file path or URL.");
    var jsonReader = new JSONReader(filepath);
    loadVars(jsonReader, "JSON object", filepath, selector);
  };
  Selenium.prototype.doLoadXmlVars = function(filepath, selector)
  {
    assert(filepath, " Requires an XML file path or URL.");
    var xmlReader = new XmlReader(filepath);
    loadVars(xmlReader, "XML element", filepath, selector);
  };
  Selenium.prototype.doLoadVars = function(filepath, selector)
  {
    $$.LOG.warn("The loadVars command has been deprecated and will be removed in future releases."
      + " Please use doLoadXmlVars instead.");
    Selenium.prototype.doLoadXmlVars(filepath, selector);
  };

  function loadVars(reader, desc, filepath, selector)
  {
    reader.load(filepath);
    reader.next(); // read first varset and set values on storedVars
    if (!selector && !reader.EOF())
      notifyFatalHere(" Multiple " + desc + "s are not valid for this command."
        + ' (A specific ' + desc + ' can be selected by specifying: name="value".)');

    var result = evalWithVars(selector);
    if (typeof result != "boolean")
      notifyFatalHere(", " + selector + " is not a boolean expression");

    // read until specified set found
    var isEof = reader.EOF();
    while (!isEof && evalWithVars(selector) != true) {
      reader.next(); // read next varset and set values on storedVars
      isEof = reader.EOF();
    } 

    if (!evalWithVars(selector))
      notifyFatalHere(desc + " not found for selector expression: " + selector
        + "; in input file " + filepath);
  };


  // ================================================================================
  Selenium.prototype.doForJson = function(jsonpath)
  {
    enterLoop(
      function(loop) {  // validate
          assert(jsonpath, " Requires a JSON file path or URL.");
          loop.jsonReader = new JSONReader();
          var localVarNames = loop.jsonReader.load(jsonpath);
          return localVarNames;
      }
      ,function() { }   // initialize
      ,function(loop) { // continue?
          var isEof = loop.jsonReader.EOF();
          if (!isEof) loop.jsonReader.next();
          return !isEof;
      }
      ,function() { }
    );
  };
  Selenium.prototype.doEndForJson = function() {
    iterateLoop();
  };

  Selenium.prototype.doForXml = function(xmlpath)
  {
    enterLoop(
      function(loop) {  // validate
          assert(xmlpath, " 'forXml' requires an XML file path or URL.");
          loop.xmlReader = new XmlReader();
          var localVarNames = loop.xmlReader.load(xmlpath);
          return localVarNames;
      }
      ,function() { }   // initialize
      ,function(loop) { // continue?
          var isEof = loop.xmlReader.EOF();
          if (!isEof) loop.xmlReader.next();
          return !isEof;
      }
      ,function() { }
    );
  };
  Selenium.prototype.doEndForXml = function() {
    iterateLoop();
  };



  // --------------------------------------------------------------------------------
  // Note: Selenium variable expansion occurs before command processing, therefore we re-execute
  // commands that *may* contain ${} variables. Bottom line, we can't just keep a copy
  // of parameters and then iterate back to the first command inside the body of a loop.

  function enterLoop(_validateFunc, _initFunc, _condFunc, _iterFunc)
  {
    assertRunning();
    var loopState;
    if (!activeBlockStack().isHere()) {
      // loop begins
      loopState = { idx: idxHere() };
      activeBlockStack().push(loopState);
      var localVars = _validateFunc(loopState);
      loopState.savedVars = getVarState(localVars);
      initVarState(localVars); // because with-scope can reference storedVars only once they exist
      _initFunc(loopState);
    }
    else {
      // iteration
      loopState = activeBlockStack().top();
      _iterFunc(loopState);
    }

    if (!_condFunc(loopState)) {
      loopState.isComplete = true;
      // jump to bottom of loop for exit
      setNextCommand(blockDefs.here().endIdx);
    }
    // else continue into body of loop
  }
  function iterateLoop()
  {
    assertRunning();
    assertActiveScope(blockDefs.here().beginIdx);
    var loopState = activeBlockStack().top();
    if (loopState.isComplete) {
      restoreVarState(loopState.savedVars);
      activeBlockStack().pop();
      // done, fall out of loop
    }
    else {
      // jump back to top of loop
      setNextCommand(blockDefs.here().beginIdx);
    }
  }

  // ================================================================================
  Selenium.prototype.doContinue = function(condExpr) {
    var loopState = dropToLoop(condExpr);
    if (loopState) {
      // jump back to top of loop for next iteration, if any
      var endCmd = blockDefs[loopState.idx];
      setNextCommand(blockDefs[endCmd.endIdx].beginIdx);
    }
  };
  Selenium.prototype.doBreak = function(condExpr) {
    var loopState = dropToLoop(condExpr);
    if (loopState) {
      loopState.isComplete = true;
      // jump to bottom of loop for exit
      setNextCommand(blockDefs[loopState.idx].endIdx);
    }
  };

  // Unwind the command stack to the inner-most active loop block
  // (unless the optional condition evaluates to false)
  function dropToLoop(condExpr)
  {
    assertRunning();
    if (transitionBubbling(Stack.isLoopBlock))
      return;
    if (condExpr && !evalWithVars(condExpr))
      return;
    var loopState = activeBlockStack().unwindTo(Stack.isLoopBlock);
    return loopState;
  }


  // ================================================================================
  Selenium.prototype.doCall = function(funcName, argSpec)
  {
    assertRunning(); // TBD: can we do single execution, ie, run from this point then break on return?
    var funcIdx = symbols[funcName];
    assert(funcIdx, " Function does not exist: " + funcName + ".");

    var activeCallFrame = callStack.top();
    if (activeCallFrame.isReturning && activeCallFrame.returnIdx == idxHere()) {
      // returning from completed function
      restoreVarState(callStack.pop().savedVars);
    }
    else {
      // save existing variable state and set args as local variables
      var args = parseArgs(argSpec);
      var savedVars = getVarStateFor(args);
      setVars(args);

      callStack.push({ funcIdx: funcIdx, name: funcName, args: args, returnIdx: idxHere(),
        savedVars: savedVars, blockStack: new Stack() });
      // jump to function body
      setNextCommand(funcIdx);
    }
  };
  Selenium.prototype.doFunction = function(funcName)
  {
    assertRunning();

    var funcDef = blockDefs.here();
    var activeCallFrame = callStack.top();
    if (activeCallFrame.funcIdx == idxHere()) {
      // get parameter values
      setVars(activeCallFrame.args);
    }
    else {
      // no active call, skip around function body
      setNextCommand(funcDef.endIdx);
    }
  };
  Selenium.prototype.doScript = function(scrName)
  {
    $$.LOG.warn("The script command has been deprecated and will be removed in future releases."
      + " Please use function instead.");
    Selenium.prototype.doFunction(scrName);
  };
  Selenium.prototype.doReturn = function(value) {
    returnFromFunction(null, value);
  };
  Selenium.prototype.doEndFunction = function(funcName) {
    returnFromFunction(funcName);
  };
  Selenium.prototype.doEndScript = function(scrName) {
    returnFromFunction(scrName);
  };

  function returnFromFunction(funcName, returnVal)
  {
    assertRunning();
    if (transitionBubbling(Stack.isFunctionBlock))
      return;
    var endDef = blockDefs.here();
    var activeCallFrame = callStack.top();
    if (activeCallFrame.funcIdx != endDef.funcIdx) {
      // no active call, we're just skipping around a function block
    }
    else {
      if (returnVal) storedVars._result = evalWithVars(returnVal);
      activeCallFrame.isReturning = true;
      // jump back to call command
      setNextCommand(activeCallFrame.returnIdx);
    }
  }


  // ================================================================================
  Selenium.prototype.doExitTest = function() {
    if (transitionBubbling())
      return;
    // intercept command processing and simply stop test execution instead of executing the next command
    $$.fn.interceptOnce(editor.selDebugger.runner.IDETestLoop.prototype, "resume", $$.handleAsExitTest);
  };


  // ========= storedVars management =========

  function evalWithVars(expr) {
    var result = null;
    try {
      // EXTENSION REVIEWERS: Use of eval is consistent with the Selenium extension itself.
      // Scripted expressions run in the Selenium window, separate from browser windows.
      // Global functions are intentional features provided for use by end user's in their Selenium scripts.
      result = eval("with (storedVars) {" + expr + "}");
    } catch (err) {
      notifyFatalErr(" While evaluating Javascript expression: " + expr, err);
    }
    return result;
  }

  function parseArgs(argSpec) { // comma-sep -> new prop-set
    var args = {};
    var parms = iexpr.splitList(argSpec, ",");
    for (var i = 0; i < parms.length; i++) {
      var keyValue = iexpr.splitList(parms[i], "=");
      validateName(keyValue[0], "parameter");
      args[keyValue[0]] = evalWithVars(keyValue[1]);
    }
    return args;
  }
  function initVarState(names) { // new -> storedVars(names)
    if (names) {
      for (var i = 0; i < names.length; i++) {
        if (!storedVars[names[i]])
          storedVars[names[i]] = null;
      }
    }
  }
  function getVarStateFor(args) { // storedVars(prop-set) -> new prop-set
    var savedVars = {};
    for (var varname in args) {
      savedVars[varname] = storedVars[varname];
    }
    return savedVars;
  }
  function getVarState(names) { // storedVars(names) -> new prop-set
    var savedVars = {};
    if (names) {
      for (var i = 0; i < names.length; i++) {
        savedVars[names[i]] = storedVars[names[i]];
      }
    }
    return savedVars;
  }
  function setVars(args) { // prop-set -> storedVars
    for (var varname in args) {
      storedVars[varname] = args[varname];
    }
  }
  function restoreVarState(savedVars) { // prop-set --> storedVars
    for (var varname in savedVars) {
      if (savedVars[varname] == undefined)
        delete storedVars[varname];
      else
        storedVars[varname] = savedVars[varname];
    }
  }

  // ========= error handling =========

  // TBD: make into throwable Errors
  function notifyFatalErr(msg, err) {
    $$.LOG.error("Error " + msg);
    $$.LOG.logStackTrace(err);
    throw err;
  }
  function notifyFatal(msg) {
    var err = new Error(msg);
    $$.LOG.error("Error " + msg);
    $$.LOG.logStackTrace(err);
    throw err;
  }
  function notifyFatalCmdRef(idx, msg) { notifyFatal(fmtCmdRef(idx) + msg); }
  function notifyFatalHere(msg) { notifyFatal(fmtCurCmd() + msg); }

  function assertCmd(idx, cond, msg) { if (!cond) notifyFatalCmdRef(idx, msg); }
  function assert(cond, msg) { if (!cond) notifyFatalHere(msg); }
  // TBD: can we at least show result of expressions?
  function assertRunning() {
    assert(testCase.debugContext.started, " Command is only valid in a running script,"
        + " i.e., cannot be executed via double-click, or via 'Execute this command'.");
  }
  function assertActiveScope(expectedIdx) {
    var activeIdx = activeBlockStack().top().idx;
    assert(activeIdx == expectedIdx, " unexpected command, active command was " + fmtCmdRef(activeIdx));
  }

  function fmtCurCmd() {
    return fmtCmdRef(idxHere());
  }
  function fmtCmdRef(idx) {
    return ("@" + (idx+1) + ": " + fmtCommand(testCase.commands[idx]));
  }
  function fmtCommand(cmd) {
    var c = cmd.command;
    if (cmd.target) c += "|" + cmd.target;
    if (cmd.value)  c += "|" + cmd.value;
    return '[' + c + ']';
  }

  //================= Javascript helpers ===============

  // Elapsed time, optional duration provides expiration
  function IntervalTimer(msDuration) {
    this.msStart = +new Date();
    this.getElapsed = function() { return (+new Date() - this.msStart); };
    this.hasExpired = function() { return (msDuration && this.getElapsed() > msDuration); };
    this.reset = function() { this.msStart = +new Date(); };
  }

  // Return a translated version of a string
  // given string args, translate each occurrence of characters in t1 with the corresponding character from t2
  // given array args, if the string occurs in t1, return the corresponding string from t2, else null
  String.prototype.translate = function(t1, t2)
  {
    assert(t1.constructor === t2.constructor, "translate() function requires arrays of the same type");
    assert(t1.length == t2.length, "translate() function requires arrays of equal size");
    if (t1.constructor === String) {
      var buf = "";
      for (var i = 0; i < this.length; i++) {
        var c = this.substr(i,1);
        for (var t = 0; t < t1.length; t++) {
          if (c == t1.substr(t,1)) {
            c = t2.substr(t,1);
            break;
          }
        }
        buf += c;
      }
      return buf;
    }
    else if (t1.constructor === Array) {
      for (var i = 0; i < t1.length; i++) {
        if (t1[i] == this)
          return t2[i];
      }
    }
    else
      assert(false, "translate() function requires arguments of type String or Array");
    return null;
  };

  // ==================== Data Files ====================
  // Adapted from the datadriven plugin
  // http://web.archive.org/web/20120928080130/http://wiki.openqa.org/display/SEL/datadriven

  function XmlReader()
  {
    var varsets = null;
    var varNames = null;
    var curVars = null;
    var varsetIdx = 0;

    // load XML file and return the list of var names found in the first <VARS> element
    this.load = function(filepath)
    {
      var fileReader = new FileReader();
      var fileUrl = urlFor(filepath);
      var xmlHttpReq = fileReader.getDocumentSynchronous(fileUrl);
      $$.LOG.info("Reading from: " + fileUrl);

      var fileObj = xmlHttpReq.responseXML; // XML DOM
      varsets = fileObj.getElementsByTagName("vars"); // HTMLCollection
      if (varsets == null || varsets.length == 0) {
        throw new Error("A <vars> element could not be loaded, or <testdata> was empty.");
      }

      curVars = 0;
      varNames = attrNamesFor(varsets[0]);
      return varNames;
    };

    this.EOF = function() {
      return (curVars == null || curVars >= varsets.length);
    };

    this.next = function()
    {
      if (this.EOF()) {
        $$.LOG.error("No more <vars> elements to read after element #" + varsetIdx);
        return;
      }
      varsetIdx++;
      $$.LOG.debug(varsetIdx + ") " + serializeXml(varsets[curVars]));  // log each name & value

      var expected = countAttrs(varsets[0]);
      var found = countAttrs(varsets[curVars]);
      if (found != expected) {
        throw new Error("Inconsistent <testdata> at <vars> element #" + varsetIdx
          + "; expected " + expected + " attributes, but found " + found + "."
          + " Each <vars> element must have the same set of attributes."
        );
      }
      setupStoredVars(varsets[curVars]);
      curVars++;
    };

    //- retrieve the names of each attribute on the given XML node
    function attrNamesFor(node) {
      var attrNames = [];
      var varAttrs = node.attributes; // NamedNodeMap
      for (var v = 0; v < varAttrs.length; v++) {
        attrNames.push(varAttrs[v].nodeName);
      }
      return attrNames;
    }

    //- determine how many attributes are present on the given node
    function countAttrs(node) {
      return node.attributes.length;
    }

    //- set selenium variables from given XML attributes
    function setupStoredVars(node) {
      var varAttrs = node.attributes; // NamedNodeMap
      for (var v = 0; v < varAttrs.length; v++) {
        var attr = varAttrs[v];
        if (null == varsets[0].getAttribute(attr.nodeName)) {
          throw new Error("Inconsistent <testdata> at <vars> element #" + varsetIdx
            + "; found attribute " + attr.nodeName + ", which does not appear in the first <vars> element."
            + " Each <vars> element must have the same set of attributes."
          );
        }
        storedVars[attr.nodeName] = attr.nodeValue;
      }
    }

    //- format the given XML node for display
    function serializeXml(node) {
      if (typeof XMLSerializer != "undefined")
        return (new XMLSerializer()).serializeToString(node) ;
      else if (node.xml) return node.xml;
      else throw "XMLSerializer is not supported or can't serialize " + node;
    }
  }


  function JSONReader()
  {
    var varsets = null;
    var varNames = null;
    var curVars = null;
    var varsetIdx = 0;

    // load JSON file and return the list of var names found in the first object
    this.load = function(filepath)
    {
      var fileReader = new FileReader();
      var fileUrl = urlFor(filepath);
      var xmlHttpReq = fileReader.getDocumentSynchronous(fileUrl);
      $$.LOG.info("Reading from: " + fileUrl);

      var fileObj = xmlHttpReq.responseText;
      varsets = eval(fileObj);
      if (varsets == null || varsets.length == 0) {
        throw new Error("A JSON object could not be loaded, or the file was empty.");
      }

      curVars = 0;
      varNames = attrNamesFor(varsets[0]);
      return varNames;
    };

    this.EOF = function() {
      return (curVars == null || curVars >= varsets.length);
    };

    this.next = function()
    {
      if (this.EOF()) {
        $$.LOG.error("No more JSON objects to read after object #" + varsetIdx);
        return;
      }
      varsetIdx++;
      $$.LOG.debug(varsetIdx + ") " + serializeJson(varsets[curVars]));  // log each name & value

      var expected = countAttrs(varsets[0]);
      var found = countAttrs(varsets[curVars]);
      if (found != expected) {
        throw new Error("Inconsistent JSON object #" + varsetIdx
          + "; expected " + expected + " attributes, but found " + found + "."
          + " Each JSON object must have the same set of attributes."
        );
      }
      setupStoredVars(varsets[curVars]);
      curVars++;
    };

    //- retrieve the names of each attribute on the given object
    function attrNamesFor(obj) {
      var attrNames = [];
      for (var attrName in obj)
        attrNames.push(attrName);
      return attrNames;
    }

    //- determine how many attributes are present on the given obj
    function countAttrs(obj) {
      var n = 0;
      for (var attrName in obj)
        n++;
      return n;
    }

    //- set selenium variables from given JSON attributes
    function setupStoredVars(obj) {
      for (var attrName in obj) {
        if (null == varsets[0][attrName]) {
          throw new Error("Inconsistent JSON at object #" + varsetIdx
            + "; found attribute " + attrName + ", which does not appear in the first JSON object."
            + " Each JSON object must have the same set of attributes."
          );
        }
        storedVars[attrName] = obj[attrName];
      }
    }

    //- format the given JSON object for display
    function serializeJson(obj) {
      var json = uneval(obj);
      return json.substring(1, json.length-1);
    }
  }

  function urlFor(filepath) {
    var URL_PFX = "file://";
    var url = filepath;
    if (filepath.substring(0, URL_PFX.length).toLowerCase() != URL_PFX) {
      testCasePath = testCase.file.path.replace("\\", "/", "g");
      var i = testCasePath.lastIndexOf("/");
      url = URL_PFX + testCasePath.substr(0, i) + "/" + filepath;
    }
    return url;
  }


  // ==================== File Reader ====================
  // Adapted from the include4ide plugin

  function FileReader() {}

  FileReader.prototype.prepareUrl = function(url) {
    var absUrl;
    // htmlSuite mode of SRC? TODO is there a better way to decide whether in SRC mode?
    if (window.location.href.indexOf("selenium-server") >= 0) {
      $$.LOG.debug("FileReader() is running in SRC mode");
      absUrl = absolutify(url, htmlTestRunner.controlPanel.getTestSuiteName());
    } else {
      absUrl = absolutify(url, selenium.browserbot.baseUrl);
    }
    $$.LOG.debug("FileReader() using URL to get file '" + absUrl + "'");
    return absUrl;
  };

  FileReader.prototype.getDocumentSynchronous = function(url) {
    var absUrl = this.prepareUrl(url);
    var requester = this.newXMLHttpRequest();
    if (!requester) {
      throw new Error("XMLHttp requester object not initialized");
    }
    requester.open("GET", absUrl, false); // synchronous (we don't want selenium to go ahead)
    try {
      requester.send(null);
    } catch(e) {
      throw new Error("Error while fetching URL '" + absUrl + "':: " + e);
    }
    if (requester.status != 200 && requester.status !== 0) {
      throw new Error("Error while fetching " + absUrl
        + " server response has status = " + requester.status + ", " + requester.statusText );
    }
    return requester;
  };

  FileReader.prototype.newXMLHttpRequest = function() {
    var requester = 0;
    try {
      // for IE/ActiveX
      if (window.ActiveXObject) {
        try {      requester = new ActiveXObject("Msxml2.XMLHTTP"); }
        catch(e) { requester = new ActiveXObject("Microsoft.XMLHTTP"); }
      }
      // Native XMLHttp
      else if (window.XMLHttpRequest) {
        requester = new XMLHttpRequest();
      }
    }
    catch(e) {
      throw new Error("Your browser has to support XMLHttpRequest in order to read data files\n" + e);
    }
    return requester;
  };

}(selblocks));
