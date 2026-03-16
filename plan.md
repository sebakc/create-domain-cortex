# Plan: create-domain-cortex

A CLI tool that scans a JavaScript/TypeScript project and generates a **Semantic Project Memory Engine** — a compressed knowledge index that lets LLMs navigate codebases, answer architecture questions, and analyze impact without reading the full repo.

---

## Goal

Transform any JS/TS project into a set of structured memory files (`memory/`) that an LLM can query with minimal tokens. The system is **deterministic by default** — no LLM required to build the index. Different project types plug in custom generation recipes via a **Strategy pattern**, evolving into a **plugin system** for framework-specific scanners.

---

## Core Concepts

### Memory structure — separated by concern

Three distinct data categories live under `memory/`, each with its own regeneration lifecycle:

```
memory/
  index/                          # deterministic knowledge index
    system.yaml                   # project fingerprint + global config
    entities.yaml                 # named entities and their domain
    domains.yaml                  # domain map with inter-domain deps
    files.yaml                    # per-file metadata (type, exports, imports, loc, hash)
    symbols.yaml                  # symbol → file → domain lookup
    graph/
      graph.yaml                  # code nodes + edges
      endpoints.yaml              # route → controller → service mapping
      dependencies.yaml           # import graph
      impact.yaml                 # reverse import graph (direct/indirect/endpoints)
    patterns/
      patterns.yaml               # executable dev recipes with template variables

  semantic/                       # derived embeddings (regenerable independently)
    docs_embeddings.json          # chunked doc embeddings
    entity_embeddings.json        # entity name embeddings
    domain_embeddings.json        # domain description + symbols + endpoints embeddings

  cache/                          # build state (never shipped, gitignored)
    file_hashes.json              # per-file content hashes
    build_meta.json               # last build timestamp, recipe used, stats

  docs/
    docs_index.yaml               # doc files and their topics
```

For large repos, domains are **sharded** into individual files:

```
memory/domains/
  users.yaml
  auth.yaml
  payments.yaml
```

So the agent only opens the domain file it needs.

### Project fingerprint (`system.yaml`)

```yaml
project:
  name: my-api
  language: typescript
  framework: express
  architecture: layered # auto-detected: layered | hexagonal | mvc | feature-based

stats:
  files: 120
  endpoints: 48
  domains: 6

memory_layers:
  code_graph: index/graph/graph.yaml
  endpoints: index/graph/endpoints.yaml
  # ...
```

Lets the agent understand project context in ~50 tokens.

### File Metadata Index (`files.yaml`)

```yaml
files:
  src/services/userService.js:
    type: service
    domain: users
    exports:
      - createUser
      - updateUser
    imports:
      - src/models/User.js
    loc: 120
    hash: 29ab3f
```

Enables precise impact analysis, entrypoint detection, and navigation.

### Symbol Index (`symbols.yaml`)

```yaml
symbols:
  createUser:
    file: src/services/userService.js
    type: function
    domain: users
  User:
    file: src/models/User.js
    type: class
    domain: users
```

Enables `memory.findSymbol("createUser")` — critical for agent code navigation.

### Domain Map (primary abstraction)

Domains are the unit of context. Each domain groups its files, endpoints, docs, and **inter-domain dependencies**:

```yaml
domains:
  users:
    description: user accounts and profile management
    files:
      - src/controllers/userController.js
      - src/services/userService.js
      - src/models/User.js
    routers:
      - src/routes/userRoutes.js
    endpoints:
      - POST /users
      - GET /users/:id
    dependencies:
      - auth
    dependents:
      - payments
    docs:
      - docs/users.md
```

Domains are detected automatically from:

- File names (`userController.js` → `users`)
- Endpoint paths (`/users/:id` → `users`)
- Model names (`User.js` → `users`)
- Doc file names (`docs/users.md` → `users`)

`memory.getDomainDependencies("users")` enables architectural analysis.

### Impact levels

Impact analysis distinguishes direct vs indirect dependents and affected endpoints:

```yaml
impact:
  src/models/User.js:
    direct:
      - src/services/userService.js
    indirect:
      - src/controllers/userController.js
    endpoints:
      - POST /users
      - GET /users/:id
```

### Executable patterns

Patterns are templates with domain variables, making the system semi-automatic:

```yaml
patterns:
  create_endpoint:
    description: add a new REST endpoint
    steps:
      - modify: router
      - create: controller_function
      - create: service_function
      - update: docs
    files:
      router: src/routes/{domain}Routes.js
      controller: src/controllers/{domain}Controller.js
      service: src/services/{domain}Service.js
```

`memory.applyPattern("create_endpoint", { domain: "users" })` resolves the template and returns concrete file paths + steps.

---

## Architecture

### 1. CLI entry point

```
npx create-domain-cortex [project-path]
```

Runs the selected recipe's `build()` and writes memory files. Outputs a token footprint summary:

```
Indexed files: 142
Domains: 7
Endpoints: 52
Architecture: layered

Full repo tokens: ~45k
Domain avg tokens: ~350
Reduction: 99.2%
```

---

### 2. Strategy pattern — Recipes → Plugins

The builder selects a **recipe** at runtime via `cortex.config.json`. Recipes evolve into a **plugin system** where each plugin can contribute scanners, pattern generators, and domain detectors.

```
recipes/
  default.js       # deterministic JS/TS scanner (built-in)
  express.js       # express-aware: deeper endpoint + middleware extraction
```

Future plugin structure:

```
plugins/
  express/         # scanners, patterns, domain detectors
  prisma/
  nextjs/
  nestjs/
```

Each recipe/plugin implements:

```javascript
export default {
  name: "default",
  build: async (projectPath, options) => { ... },
  update: async (projectPath, changedFiles, options) => { ... }
}
```

`build` = full regeneration. `update` = incremental pass (watch mode, pre-commit).

Selection: `cortex.config.json` → `recipe` field → falls back to `"default"`.

---

### 3. `memory-builder/` — shared scanner modules

Recipes compose from reusable modules:

```
memory-builder/
  scanRepo.js           # collect all .js/.ts files
  scanImports.js        # AST-based import graph (@babel/parser + @babel/traverse)
  scanExports.js        # AST-based export extraction (for symbols.yaml + files.yaml)
  scanEndpoints.js      # regex extraction of router.get/post/put/delete calls
  scanDocs.js           # read and chunk markdown files in docs/
  detectArchitecture.js # infer project architecture style (layered, hexagonal, mvc, feature-based)
  buildGraph.js         # nodes + edges from files + imports
  buildImpact.js        # invert graph with direct/indirect levels + endpoint propagation
  buildDomainMap.js     # group files/endpoints/docs by domain with inter-domain deps
  buildSymbolIndex.js   # symbol → file → domain map
  buildFileIndex.js     # per-file metadata (type, exports, imports, loc, hash)
  buildEmbeddings.js    # embeddings for docs, entities, and domains
  writeMemory.js        # serialize to index/ + semantic/ + cache/
  hashCache.js          # file hashing for incremental updates
```

Default recipe orchestration:

```javascript
async function build(projectPath) {
  const files = await scanRepo(projectPath);
  const imports = scanImports(files);
  const exports = scanExports(files);
  const endpoints = scanEndpoints(files);
  const architecture = detectArchitecture(files, imports);
  const graph = buildGraph(files, imports);
  const impact = buildImpact(graph, endpoints);
  const docs = scanDocs(projectPath);
  const domains = buildDomainMap(files, endpoints, docs, imports);
  const symbols = buildSymbolIndex(exports, domains);
  const fileIndex = buildFileIndex(files, imports, exports, domains);
  const embeddings = await buildEmbeddings(docs, domains, symbols);

  writeMemory({
    architecture,
    graph,
    endpoints,
    impact,
    domains,
    symbols,
    fileIndex,
    embeddings,
  });
}
```

### Truly incremental watch mode

Instead of full rebuild, `update()` scopes changes:

```
file change
  ↓ detect affected domain(s)
  ↓ re-scan only changed files (imports, exports, endpoints)
  ↓ update graph nodes + edges for those files
  ↓ recompute impact for affected subgraph
  ↓ update domain map entries
  ↓ update symbols for changed files
```

---

### 4. Query engine

#### Natural language API

```javascript
memory.ask(question);
memory.detectDomain(question);
memory.getDomain('users');
memory.getDomainEndpoints('users');
memory.getDomainDocs('users');
memory.getDomainDependencies('users');
memory.getImpact('src/services/userService.js');
memory.findSymbol('createUser');
memory.applyPattern('create_endpoint', { domain: 'users' });
```

#### Structured query language

For deterministic queries without LLM interpretation:

```
memory.query("endpoints(domain=users)")
memory.query("impact(file=src/models/User.js)")
memory.query("files(type=service, domain=users)")
memory.query("symbol(createUser)")
```

---

### 5. `ask()` pipeline

Symbol lookup happens **before** domain detection for better precision:

```
question
  ↓ intent detection        (rule-based or embedding similarity)
  ↓ entity detection        (match against entity_embeddings.json)
  ↓ symbol lookup           (exact match in symbols.yaml)
  ↓ domain resolution       (entity/symbol → domain from domains.yaml)
  ↓ pattern match           (intent → patterns.yaml)
  ↓ graph query             (getDomainComponents)
  ↓ doc retrieval           (cosine similarity on docs_embeddings.json)
  ↓ context assembly        (< 300 tokens)
  ↓ (optional) LLM call     (only receives filtered context)
```

---

### 6. Domain embeddings

Embeddings cover more than just doc text. Each domain embedding combines:

- domain description
- endpoint list
- symbol names

Example embedding source text:

```
users domain user account profile createUser updateUser deleteUser POST /users GET /users/:id
```

This greatly improves semantic domain detection from natural language queries.

---

## Implementation Phases

### Phase 1 — Scaffold

- [ ] Initialize project (ESM + TypeScript)
- [ ] CLI entry point (`bin/index.js`)
- [ ] Dependencies: `@babel/parser`, `@babel/traverse`, `js-yaml`, `glob`
- [ ] Recipe interface + strategy selector
- [ ] `memory/` directory structure: `index/`, `semantic/`, `cache/`, `docs/`

### Phase 2 — Scanner modules

- [ ] `scanRepo` — walk `src/` and collect `.js`/`.ts` files
- [ ] `scanImports` — AST-based dependency extraction
- [ ] `scanExports` — AST-based export extraction (functions, classes, constants)
- [ ] `scanEndpoints` — regex extraction from router files
- [ ] `scanDocs` — read and chunk `.md` files from `docs/`
- [ ] `detectArchitecture` — infer layered / hexagonal / mvc / feature-based

### Phase 3 — Index builders

- [ ] `buildGraph` — nodes (file, type) + edges (imports)
- [ ] `buildImpact` — direct/indirect levels + endpoint propagation
- [ ] `buildDomainMap` — infer domains, inter-domain dependencies/dependents
- [ ] `buildSymbolIndex` — symbol → file → domain
- [ ] `buildFileIndex` — per-file metadata (type, exports, imports, loc, hash)

### Phase 4 — Embeddings

- [ ] `buildEmbeddings` — doc chunks + domain descriptions + symbol names
- [ ] `buildEntityEmbeddings` — entity names for semantic resolution

### Phase 5 — Memory writer + cache

- [ ] `writeMemory` — serialize to `index/`, `semantic/`, `docs/`
- [ ] `hashCache` — file hashes in `cache/file_hashes.json`
- [ ] `build_meta.json` — timestamp, recipe, stats
- [ ] Domain sharding for large repos (`memory/domains/*.yaml`)

### Phase 6 — Default recipe

- [ ] Wire all modules into `recipes/default.js` (`{ build, update }`)
- [ ] Incremental `update()`: scope to affected domains, update subgraph only
- [ ] Strategy selector from `cortex.config.json`

### Phase 7 — Query engine

- [ ] `memory.getDomain()`, `memory.getImpact()`, `memory.findSymbol()`
- [ ] `memory.query()` — structured query language
- [ ] `memory.ask()` — full pipeline (intent → entity → symbol → domain → graph → docs → LLM)
- [ ] `memory.applyPattern()` — resolve template variables, return concrete steps + files
- [ ] Cosine similarity search over `semantic/docs_embeddings.json`

### Phase 8 — CLI polish

- [ ] `cortex.config.json` (recipe selection, custom domain hints, src paths)
- [ ] `--watch` mode with truly incremental domain-scoped updates
- [ ] Token footprint summary output
- [ ] Architecture detection in output

### Phase 9 — Plugin system (future)

- [ ] Plugin interface: scanners, pattern generators, domain detectors
- [ ] Built-in plugins: express, prisma, nextjs, nestjs

---

## Key Design Decisions

- **Deterministic by default** — the default recipe requires no LLM to generate memory
- **Separated concerns** — `index/` (deterministic) vs `semantic/` (embeddings) vs `cache/` (build state) have independent regeneration lifecycles
- **Strategy pattern → plugin system** — recipes compose from shared scanner modules; plugins extend with framework-specific scanners and patterns
- **Domain is the primary unit** — always load by domain, never the full graph; large repos shard domains into individual files
- **Symbol-first resolution** — symbol lookup before domain detection improves precision in the `ask()` pipeline
- **Impact levels** — direct/indirect/endpoint propagation enables precise "what breaks" analysis
- **Executable patterns** — templates with `{domain}` variables make the system semi-automatic for code generation
- **Structured query language** — `memory.query()` handles deterministic lookups without LLM interpretation
- **Embeddings are the fallback** — when rule-based detection fails, cosine similarity resolves entities and domains
- **Truly incremental** — watch mode scopes changes to affected domains and updates only the relevant subgraph
