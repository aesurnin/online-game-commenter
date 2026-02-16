# Contributing

## Language: English Only

**This project is conducted entirely in English.** All contributors must follow this convention.

### Scope

| Area | Language | Examples |
|------|----------|----------|
| **Code** | English | Variable names, function names, file names |
| **Comments** | English | Inline comments, JSDoc, block comments |
| **UI / UX** | English | Labels, buttons, messages, placeholders, tooltips |
| **Documentation** | English | README, docs, commit messages |
| **API** | English | Endpoint paths, response keys, error messages |

### Examples

```typescript
// ✅ Good
const uploadedVideos = [];
function handleVideoUpload() {}
// Fetches project videos from the API

// ❌ Bad
const zagruzhennyeVideo = [];
function obrabotkaZagruzki() {}
// Получает видео проекта из API
```

```tsx
// ✅ Good
<Button>Upload video</Button>
<span>No preview available</span>

// ❌ Bad
<Button>Загрузить видео</Button>
<span>Нет превью</span>
```

### Rationale

- Consistent codebase for international contributors
- Easier onboarding and code review
- Standard practice in open-source and professional projects
