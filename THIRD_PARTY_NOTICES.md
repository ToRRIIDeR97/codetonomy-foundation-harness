# Third-party notices

This project directly depends on selected packages from
[`earendil-works/pi`](https://github.com/earendil-works/pi) at commit
`2e4d23959485279aa2da1a45103de2ea22d46395`.

Pi is licensed under the MIT License, Copyright (c) 2025 Mario Zechner:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

The query-centered snippet logic adapts Reasonix's `MakeSnippet`, licensed
under the same MIT terms above, Copyright (c) 2026 Reasonix Contributors.

OpenAI Codex (Apache-2.0) is not distributed in this project. `scripts/install-sandbox.mjs`
installs the pinned `@openai/codex` npm package, recorded in
`deployment/sandbox-version.env`, into a separate worker directory and checks its
integrity; it is used only as the engine of the Codetonomy command sandbox.

The pnpm patch in `patches/@earendil-works__pi-ai@0.84.1.patch` modifies Pi
0.84.1 provider finalization, argument validation, and provider retry telemetry.
The MIT copyright and permission notice above apply to these modifications.
