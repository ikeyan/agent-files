---
name: smart-handoff
description: Save your current flow, decisions, and next steps for seamless context handoff
---

# Smart Handoff

Analyze our entire conversation and prepare for a context handoff. I need you to:

1. **Generate a comprehensive working context file** by analyzing what we've been working on
2. **Suggest the best compact command** based on what you found
3. **Provide recovery instructions** in case compact fails

First, create/overwrite `context/WORKING.md` with this analysis:

```markdown
# Session Context - [current timestamp in ISO 8601 format with timezone, e.g., 2025-08-11T17:00:00Z]

## Current Session Overview
- **Main Task/Feature**: [What we're working on right now]
- **Session Duration**: [How long we've been working]
- **Current Status**: [Exactly where we are in the process]

## Recent Activity (Last 30-60 minutes)
- **What We Just Did**: [Most recent changes, decisions, implementations]
- **Active Problems**: [Issues we're currently solving]
- **Current Files**: [Files we're actively modifying]
- **Test Status**: [What's working/broken right now]

## Key Technical Decisions Made
- **Architecture Choices**: [Major structural decisions and why]
- **Implementation Approaches**: [Patterns/techniques we've settled on]
- **Technology Selections**: [Libraries, frameworks, tools chosen]
- **Performance/Security Considerations**: [Important constraints]

## Code Context
- **Modified Files**: [List files changed in this session]
- **New Patterns**: [Coding conventions or patterns established]
- **Dependencies**: [New packages/libraries added]
- **Configuration Changes**: [Environment, build, or config updates]

## Current Implementation State
- **Completed**: [What's fully implemented and tested]
- **In Progress**: [What's partially done - be specific about state]
- **Blocked**: [What's waiting on something else]
- **Next Steps**: [Immediate actions needed, prioritized]

## Important Context for Handoff
- **Environment Setup**: [Special requirements or configurations]
- **Running/Testing**: [How to run, build, test the current work]
- **Known Issues**: [Bugs, limitations, or gotchas discovered]
- **External Dependencies**: [APIs, services, or tools being used]

## Conversation Thread
- **Original Goal**: [What we started trying to accomplish]
- **Evolution**: [How the task has changed or expanded]
- **Lessons Learned**: [Important insights discovered during work]
- **Alternatives Considered**: [Approaches we tried and rejected]

After creating the WORKING.md file, output EXACTLY AND ONLY these 3 lines:

```
✅ **Context saved to** `context/WORKING.md`

🎯 **Copy/paste this compact command:**
/compact [your specific instruction based on our work]

🔄 **Copy/paste AFTER compact:**
Read context/WORKING.md and continue development
```

DO NOT add ANY other text. NO bullets, NO emojis, NO summaries, NO explanations.
ONLY the 3 lines above. Nothing before them. Nothing after them.