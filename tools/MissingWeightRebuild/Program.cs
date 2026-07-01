using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

var dataDir   = GetArg("--data-dir", "backend/data");
var weightsPath = GetArg("--weights", "");
var outPath   = GetArg("--out", Path.Combine(dataDir, "missing_weight.json"));

// ── Загружаем таблицу весов: { "УТ-123": 500.0, ... } (артикул → граммы) ─────
var weights = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
if (!string.IsNullOrEmpty(weightsPath) && File.Exists(weightsPath))
{
    try
    {
        using var wf  = File.OpenRead(weightsPath);
        using var wdoc = JsonDocument.Parse(wf);
        foreach (var prop in wdoc.RootElement.EnumerateObject())
            if (prop.Value.ValueKind == JsonValueKind.Number)
                weights[prop.Name] = prop.Value.GetDouble();
    }
    catch { /* если файл сломан — работаем без весов из Excel */ }
}

var byKey = new Dictionary<string, MissingItem>(StringComparer.Ordinal);

// ── Обходим все data/YYYY-MM-DD/HH.json ──────────────────────────────────────
if (Directory.Exists(dataDir))
{
    foreach (var dateDir in Directory.EnumerateDirectories(dataDir))
    {
        if (!Regex.IsMatch(Path.GetFileName(dateDir), @"^\d{4}-\d{2}-\d{2}$")) continue;

        foreach (var file in Directory.EnumerateFiles(dateDir, "*.json"))
        {
            // только почасовые файлы вида HH.json (00–23)
            if (!Regex.IsMatch(Path.GetFileNameWithoutExtension(file), @"^\d{2}$")) continue;

            try
            {
                using var fs  = File.OpenRead(file);
                using var doc = JsonDocument.Parse(fs);
                if (!doc.RootElement.TryGetProperty("items", out var itemsEl) ||
                    itemsEl.ValueKind != JsonValueKind.Array) continue;

                foreach (var item in itemsEl.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.Object) continue;

                    var opType = (GetStr(item, "operationType", "type") ?? "").ToUpperInvariant();
                    if (opType != "PICK_BY_LINE" && opType != "PIECE_SELECTION_PICKING") continue;

                    var name    = (GetProductName(item) ?? "").Trim();
                    if (string.IsNullOrEmpty(name)) continue;

                    var article = (GetArticle(item) ?? "").Trim();

                    // Есть вес из Excel?
                    if (!string.IsNullOrEmpty(article) && weights.ContainsKey(article)) continue;

                    var key = !string.IsNullOrEmpty(article) ? article : name;
                    byKey.TryAdd(key, new MissingItem(name, article));
                }
            }
            catch { /* пропускаем сломанные файлы */ }
        }
    }
}

// ── Сортируем и записываем missing_weight.json ────────────────────────────────
var sorted = byKey.Values
    .OrderBy(x => x.Name, StringComparer.Create(CultureInfo.GetCultureInfo("ru-RU"), false))
    .ToList();

var outList = sorted.Select(x => new { name = x.Name, article = x.Article });

Directory.CreateDirectory(Path.GetDirectoryName(outPath) ?? dataDir);
File.WriteAllText(outPath,
    JsonSerializer.Serialize(outList, new JsonSerializerOptions { WriteIndented = true }),
    new System.Text.UTF8Encoding(false));

Console.WriteLine(JsonSerializer.Serialize(new { ok = true, count = sorted.Count }));

// ── Вспомогательные функции ───────────────────────────────────────────────────
static string? GetStr(JsonElement el, params string[] props)
{
    foreach (var p in props)
        if (el.TryGetProperty(p, out var v) && v.ValueKind == JsonValueKind.String)
            return v.GetString();
    return null;
}

static string? GetProductName(JsonElement item)
{
    var flat = GetStr(item, "productName", "name");
    if (!string.IsNullOrWhiteSpace(flat)) return flat;

    if (!item.TryGetProperty("product", out var product)) return null;
    if (product.ValueKind == JsonValueKind.String) return product.GetString();
    if (product.ValueKind == JsonValueKind.Object) return GetStr(product, "name", "productName");
    return null;
}

static string? GetArticle(JsonElement item)
{
    var flat = GetStr(item, "nomenclatureCode", "article");
    if (!string.IsNullOrWhiteSpace(flat)) return flat;

    if (!item.TryGetProperty("product", out var product) || product.ValueKind != JsonValueKind.Object) return null;
    return GetStr(product, "nomenclatureCode", "article");
}

string GetArg(string key, string defaultValue)
{
    for (var i = 0; i < args.Length - 1; i++)
        if (args[i].Equals(key, StringComparison.OrdinalIgnoreCase))
            return args[i + 1];
    return defaultValue;
}

record MissingItem(string Name, string Article);
