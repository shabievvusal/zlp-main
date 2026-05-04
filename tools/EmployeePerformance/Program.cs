using System.Collections.Concurrent;
using System.Text.Json;

// ─── Args ──────────────────────────────────────────────────────────────────────

var dataDir    = GetArg("--data-dir",  "backend/data");
var dateFrom   = GetArg("--date-from", "");
var dateTo     = GetArg("--date-to",   "");
var shift      = GetArg("--shift",     ""); // "day" | "night" | "" = все смены
var zoneFilter = GetArg("--zone",      ""); // "HH" | "KDH" | "SH" | "KDS" | "MH" | "KDM" | "" = все зоны

if (string.IsNullOrWhiteSpace(dateFrom) || string.IsNullOrWhiteSpace(dateTo))
{
    Console.Error.WriteLine("Usage: EmployeePerformance --data-dir <path> --date-from YYYY-MM-DD --date-to YYYY-MM-DD [--shift day|night] [--zone HH|KDH|SH|KDS|MH|KDM]");
    Environment.Exit(2);
}

// ─── Date list ─────────────────────────────────────────────────────────────────

var dates = new List<string>();
{
    var cur = DateTime.Parse(dateFrom);
    var end = DateTime.Parse(dateTo);
    while (cur <= end) { dates.Add(cur.ToString("yyyy-MM-dd")); cur = cur.AddDays(1); }
}

// ─── Process each date in parallel, collect per-date dictionaries ──────────────

var dailyResults = new ConcurrentBag<Dictionary<string, DailyEmplStats>>();

Parallel.ForEach(dates, dateStr =>
{
    var dir = Path.Combine(dataDir, dateStr);
    if (!Directory.Exists(dir)) return;

    var dayMap = new Dictionary<string, DailyEmplStats>();

    foreach (var file in Directory.GetFiles(dir, "??.json"))
    {
        List<LightItem> items;
        try
        {
            using var fs = File.OpenRead(file);
            using var doc = JsonDocument.Parse(fs);
            if (!doc.RootElement.TryGetProperty("items", out var itemsEl) || itemsEl.ValueKind != JsonValueKind.Array)
                continue;
            items = new(itemsEl.GetArrayLength());
            foreach (var el in itemsEl.EnumerateArray())
                if (el.ValueKind == JsonValueKind.Object) items.Add(LightItem.FromJson(el));
        }
        catch { continue; }

        foreach (var item in items)
        {
            var opType = (item.OperationType ?? "").ToUpperInvariant();
            var isKdk     = opType == "PICK_BY_LINE";
            var isStorage = opType == "PIECE_SELECTION_PICKING";
            if (!isKdk && !isStorage) continue;
            if (!string.IsNullOrEmpty(shift) && !IsInShift(item.CompletedAt, shift)) continue;

            var executor   = string.IsNullOrWhiteSpace(item.Executor) ? "Неизвестно" : item.Executor.Trim();
            var executorId = item.ExecutorId ?? "";
            var cell       = item.Cell ?? "";
            var zoneKey    = GetZonePrefix(cell);

            if (!string.IsNullOrEmpty(zoneFilter) &&
                !zoneKey.Equals(zoneFilter, StringComparison.OrdinalIgnoreCase)) continue;

            var normKey = NormFio(executor);
            if (!dayMap.TryGetValue(normKey, out var ds))
                dayMap[normKey] = ds = new DailyEmplStats { Name = executor, ExecutorId = executorId };
            if (string.IsNullOrEmpty(ds.ExecutorId) && !string.IsNullOrEmpty(executorId))
                ds.ExecutorId = executorId;

            // Task deduplication: KDK — по (executor|cell|product), хранение — по id
            var nomenclature = item.NomenclatureCode ?? "";
            var productName  = item.ProductName ?? "";
            string taskKey = isKdk
                ? $"task|{executor}|{cell}|{(string.IsNullOrEmpty(nomenclature) ? productName : nomenclature)}"
                : $"id|{item.Id ?? ""}";
            ds.TaskKeys.Add(taskKey);

            if (!string.IsNullOrEmpty(item.CompletedAt) &&
                DateTime.TryParse(item.CompletedAt, null, System.Globalization.DateTimeStyles.AdjustToUniversal, out var ts))
            {
                if (ds.FirstAt == null || ts < ds.FirstAt) ds.FirstAt = ts;
                if (ds.LastAt  == null || ts > ds.LastAt)  ds.LastAt  = ts;
            }
        }
    }

    if (dayMap.Count > 0) dailyResults.Add(dayMap);
});

// ─── Merge daily results ───────────────────────────────────────────────────────

var byEmployee = new Dictionary<string, EmployeeStats>();

foreach (var dayMap in dailyResults)
{
    foreach (var (normKey, ds) in dayMap)
    {
        var taskCount = ds.TaskKeys.Count;
        if (taskCount == 0) continue;

        double dayWorkedMin = (ds.FirstAt.HasValue && ds.LastAt.HasValue && ds.LastAt > ds.FirstAt)
            ? (ds.LastAt.Value - ds.FirstAt.Value).TotalMinutes
            : 0;

        if (!byEmployee.TryGetValue(normKey, out var es))
            byEmployee[normKey] = es = new EmployeeStats { Name = ds.Name, ExecutorId = ds.ExecutorId };
        if (string.IsNullOrEmpty(es.ExecutorId) && !string.IsNullOrEmpty(ds.ExecutorId))
            es.ExecutorId = ds.ExecutorId;

        es.Total         += taskCount;
        es.WorkedMinutes += dayWorkedMin;
    }
}

// ─── Output ────────────────────────────────────────────────────────────────────

var rows = byEmployee.Values
    .Where(es => es.Total > 0)
    .OrderByDescending(es => es.Total)
    .Select(es => new
    {
        name          = es.Name,
        executorId    = es.ExecutorId,
        total         = es.Total,
        workedMinutes = Math.Round(es.WorkedMinutes, 1),
    })
    .ToList();

Console.WriteLine(JsonSerializer.Serialize(new
{
    ok       = true,
    dateFrom,
    dateTo,
    zone     = zoneFilter,
    count    = rows.Count,
    rows,
}, new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    WriteIndented        = false,
}));

// ─── Helpers ───────────────────────────────────────────────────────────────────

static string GetZonePrefix(string cell)
{
    if (string.IsNullOrWhiteSpace(cell)) return "";
    var dash = cell.IndexOf('-');
    return dash > 0 ? cell[..dash].ToUpperInvariant() : cell.ToUpperInvariant();
}

static string NormFio(string fio) =>
    System.Text.RegularExpressions.Regex.Replace(fio.Trim(), @"\s+", " ").ToLowerInvariant();

static bool IsInShift(string? completedAt, string shift)
{
    if (string.IsNullOrEmpty(completedAt)) return true;
    if (!DateTime.TryParse(completedAt, null, System.Globalization.DateTimeStyles.AdjustToUniversal, out var utc)) return true;
    var moscowHour = (utc.Hour + 3) % 24;
    return shift == "day"
        ? moscowHour >= 9 && moscowHour < 21
        : moscowHour < 9 || moscowHour >= 21;
}

string GetArg(string key, string defaultValue)
{
    for (var i = 0; i < args.Length - 1; i++)
        if (args[i].Equals(key, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
    return defaultValue;
}

// ─── Types ─────────────────────────────────────────────────────────────────────

class DailyEmplStats
{
    public string          Name       { get; set; } = "";
    public string          ExecutorId { get; set; } = "";
    public HashSet<string> TaskKeys   { get; }      = new();
    public DateTime?       FirstAt    { get; set; }
    public DateTime?       LastAt     { get; set; }
}

class EmployeeStats
{
    public string  Name          { get; set; } = "";
    public string  ExecutorId    { get; set; } = "";
    public int     Total         { get; set; }
    public double  WorkedMinutes { get; set; }
}

record LightItem
{
    public string? Id              { get; init; }
    public string? OperationType   { get; init; }
    public string? NomenclatureCode { get; init; }
    public string? ProductName     { get; init; }
    public string? Cell            { get; init; }
    public string? CompletedAt     { get; init; }
    public string? Executor        { get; init; }
    public string? ExecutorId      { get; init; }

    public static LightItem FromJson(JsonElement el)
    {
        static string Get(JsonElement o, string n) =>
            o.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        return new LightItem
        {
            Id               = Get(el, "id"),
            OperationType    = Get(el, "operationType"),
            NomenclatureCode = Get(el, "nomenclatureCode"),
            ProductName      = Get(el, "productName"),
            Cell             = Get(el, "cell"),
            CompletedAt      = Get(el, "completedAt"),
            Executor         = Get(el, "executor"),
            ExecutorId       = Get(el, "executorId"),
        };
    }
}
