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

// ── Регулярки для определения веса по названию товара ────────────────────────
var unitRe  = new Regex(@"\b\d+(?:[.,]\d+)?\s*(?:кг|г|л|мл|kg|g|l|ml)\b",
    RegexOptions.IgnoreCase | RegexOptions.Compiled);
var comboRe = new Regex(@"\b\d+(?:[.,]\d+)?\s*[xх×]\s*\d+(?:[.,]\d+)?\s*(?:кг|г|л|мл|kg|g|l|ml)\b",
    RegexOptions.IgnoreCase | RegexOptions.Compiled);

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

                    var name    = (GetStr(item, "productName", "product", "name") ?? "").Trim();
                    if (string.IsNullOrEmpty(name)) continue;

                    var article = (GetStr(item, "nomenclatureCode", "article") ?? "").Trim();

                    // Есть вес из Excel?
                    if (!string.IsNullOrEmpty(article) && weights.ContainsKey(article)) continue;

                    // Вес вычисляется из названия?
                    var norm = name.Replace("\u00a0", " ").Replace("\u202f", " ");
                    if (comboRe.IsMatch(norm) || unitRe.IsMatch(norm)) continue;

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
    System.Text.Encoding.UTF8);

Console.WriteLine(JsonSerializer.Serialize(new { ok = true, count = sorted.Count }));

// ── Вспомогательные функции ───────────────────────────────────────────────────
static string? GetStr(JsonElement el, params string[] props)
{
    foreach (var p in props)
        if (el.TryGetProperty(p, out var v) && v.ValueKind == JsonValueKind.String)
            return v.GetString();
    return null;
}

string GetArg(string key, string defaultValue)
{
    for (var i = 0; i < args.Length - 1; i++)
        if (args[i].Equals(key, StringComparison.OrdinalIgnoreCase))
            return args[i + 1];
    return defaultValue;
}

record MissingItem(string Name, string Article);
