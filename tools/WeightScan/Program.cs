using System.Text.Json;
using System.Text.RegularExpressions;

var rootDir = GetArg("--root", "backend/data");
var mode = GetArg("--mode", "both").ToLowerInvariant();
var outCounts = GetArg("--out-counts", "weight_missing_report.txt");
var outUnique = GetArg("--out-unique", "weight_missing_report_unique.txt");

var unitRe = new Regex(@"\b\d+(?:[.,]\d+)?\s*(?:кг|г|л|мл)\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);
var comboRe = new Regex(@"\b\d+\s*[xх×]\s*\d+(?:[.,]\d+)?\s*(?:кг|г|л|мл)\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);

var missingCounts = new Dictionary<string, int>(StringComparer.Ordinal);
var missingExamples = new Dictionary<string, Example>(StringComparer.Ordinal);
var uniqueMissing = new Dictionary<string, Example>(StringComparer.Ordinal);

long withWeight = 0;
long withoutWeight = 0;
long nullName = 0;
int filesScanned = 0;

foreach (var path in Directory.EnumerateFiles(rootDir, "*.json", SearchOption.AllDirectories))
{
    var baseName = Path.GetFileName(path);
    if (baseName.Equals("vs-logins.json", StringComparison.OrdinalIgnoreCase) ||
        baseName.Equals("vs-telegram-bind.json", StringComparison.OrdinalIgnoreCase) ||
        baseName.Equals("rollcall.json", StringComparison.OrdinalIgnoreCase))
    {
        continue;
    }

    try
    {
        using var fs = File.OpenRead(path);
        using var doc = JsonDocument.Parse(fs);
        if (!TryGetItems(doc.RootElement, out var items))
        {
            continue;
        }
        filesScanned++;

        foreach (var item in items.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) continue;
            var name = GetName(item);
            if (string.IsNullOrWhiteSpace(name))
            {
                nullName++;
                continue;
            }

            var norm = NormalizeName(name);
            var hasWeight = unitRe.IsMatch(norm) || comboRe.IsMatch(norm);
            if (hasWeight)
            {
                withWeight++;
                continue;
            }

            withoutWeight++;
            if (missingCounts.TryGetValue(name, out var cnt)) missingCounts[name] = cnt + 1;
            else missingCounts[name] = 1;

            if (!missingExamples.ContainsKey(name))
            {
                missingExamples[name] = BuildExample(item, path);
            }
            if (!uniqueMissing.ContainsKey(name))
            {
                uniqueMissing[name] = BuildExample(item, path);
            }
        }
    }
    catch
    {
        // ignore broken files
    }
}

if (mode is "counts" or "both")
{
    using var outFile = new StreamWriter(outCounts, false, System.Text.Encoding.UTF8);
    outFile.WriteLine($"files_scanned: {filesScanned}");
    outFile.WriteLine($"with_weight: {withWeight}");
    outFile.WriteLine($"without_weight: {withoutWeight}");
    outFile.WriteLine($"null_name: {nullName}");
    outFile.WriteLine();
    outFile.WriteLine("Top 200 products without weight (name -> count | example barcode | time | file):");
    foreach (var kv in missingCounts.OrderByDescending(k => k.Value).ThenBy(k => k.Key).Take(200))
    {
        var ex = missingExamples[kv.Key];
        outFile.WriteLine($"{kv.Value}\t{kv.Key}\t| {ex.Barcode} | {ex.Time} | {ex.File}");
    }
}

if (mode is "unique" or "both")
{
    using var outFile = new StreamWriter(outUnique, false, System.Text.Encoding.UTF8);
    outFile.WriteLine($"files_scanned: {filesScanned}");
    outFile.WriteLine($"unique_missing_count: {uniqueMissing.Count}");
    outFile.WriteLine($"null_name: {nullName}");
    outFile.WriteLine();
    outFile.WriteLine("Unique products without weight (name | example barcode | time | file):");
    foreach (var kv in uniqueMissing.OrderBy(k => k.Key))
    {
        var ex = kv.Value;
        outFile.WriteLine($"{kv.Key}\t| {ex.Barcode} | {ex.Time} | {ex.File}");
    }
}

Console.WriteLine("Done");

string GetArg(string key, string defaultValue)
{
    for (var i = 0; i < args.Length; i++)
    {
        if (!args[i].Equals(key, StringComparison.OrdinalIgnoreCase)) continue;
        if (i + 1 < args.Length) return args[i + 1];
    }
    return defaultValue;
}

static string NormalizeName(string name)
{
    return name.Replace("\u00a0", " ").Replace("\u202f", " ").Trim();
}

static string? GetName(JsonElement obj)
{
    if (obj.TryGetProperty("productName", out var v) && v.ValueKind == JsonValueKind.String) return v.GetString();
    if (obj.TryGetProperty("product", out v) && v.ValueKind == JsonValueKind.String) return v.GetString();
    if (obj.TryGetProperty("name", out v) && v.ValueKind == JsonValueKind.String) return v.GetString();
    return null;
}

static Example BuildExample(JsonElement obj, string path)
{
    string? barcode = null;
    if (obj.TryGetProperty("productBarcode", out var v) && v.ValueKind == JsonValueKind.String) barcode = v.GetString();
    else if (obj.TryGetProperty("barcode", out v) && v.ValueKind == JsonValueKind.String) barcode = v.GetString();

    string? time = null;
    if (obj.TryGetProperty("operationCompletedAt", out v) && v.ValueKind == JsonValueKind.String) time = v.GetString();
    else if (obj.TryGetProperty("completedAt", out v) && v.ValueKind == JsonValueKind.String) time = v.GetString();
    else if (obj.TryGetProperty("createdAt", out v) && v.ValueKind == JsonValueKind.String) time = v.GetString();

    return new Example(barcode, time, path);
}

static bool TryGetItems(JsonElement root, out JsonElement items)
{
    if (root.ValueKind == JsonValueKind.Array)
    {
        items = root;
        return true;
    }
    if (root.ValueKind == JsonValueKind.Object)
    {
        if (root.TryGetProperty("value", out var value) && value.ValueKind == JsonValueKind.Object)
        {
            if (value.TryGetProperty("items", out var valueItems) && valueItems.ValueKind == JsonValueKind.Array)
            {
                items = valueItems;
                return true;
            }
        }
        if (root.TryGetProperty("items", out var itemsProp) && itemsProp.ValueKind == JsonValueKind.Array)
        {
            items = itemsProp;
            return true;
        }
        if (root.TryGetProperty("data", out var dataProp) && dataProp.ValueKind == JsonValueKind.Object)
        {
            if (dataProp.TryGetProperty("items", out var dataItems) && dataItems.ValueKind == JsonValueKind.Array)
            {
                items = dataItems;
                return true;
            }
        }
    }
    items = default;
    return false;
}

record Example(string? Barcode, string? Time, string File);
