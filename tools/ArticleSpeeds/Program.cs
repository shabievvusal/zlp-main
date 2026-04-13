using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;

// ─── Args ──────────────────────────────────────────────────────────────────────

var dataDir   = GetArg("--data-dir",   "backend/data");
var dateFrom  = GetArg("--date-from",  "");
var dateTo    = GetArg("--date-to",    "");
var opFilter  = GetArg("--op-type",    "");   // PICK_BY_LINE | PIECE_SELECTION_PICKING | "" = оба
var zoneFilter = GetArg("--zone",      "");   // KDS | KDH | SH | HH | "" = все

if (string.IsNullOrWhiteSpace(dateFrom) || string.IsNullOrWhiteSpace(dateTo))
{
    Console.Error.WriteLine("Usage: ArticleSpeeds --data-dir <path> --date-from YYYY-MM-DD --date-to YYYY-MM-DD [--op-type PICK_BY_LINE|PIECE_SELECTION_PICKING] [--zone KDS|KDH|SH|HH|HH|MH]");
    Environment.Exit(2);
}

// ─── Collect date list ─────────────────────────────────────────────────────────

var dates = new List<string>();
{
    var cur = DateTime.Parse(dateFrom);
    var end = DateTime.Parse(dateTo);
    while (cur <= end) { dates.Add(cur.ToString("yyyy-MM-dd")); cur = cur.AddDays(1); }
}

// ─── Aggregate per (NomenclatureCode, Zone, OperationType) ────────────────────
// Используем ConcurrentDictionary для параллельного чтения файлов

var agg = new ConcurrentDictionary<AggKey, AggValue>(AggKeyComparer.Instance);

// Параллельно по датам
Parallel.ForEach(dates, dateStr =>
{
    var dir = Path.Combine(dataDir, dateStr);
    if (!Directory.Exists(dir)) return;

    var hourFiles = Directory.GetFiles(dir, "??.json");
    foreach (var file in hourFiles)
    {
        List<LightItem> items;
        try
        {
            using var fs = File.OpenRead(file);
            using var doc = JsonDocument.Parse(fs);
            if (!doc.RootElement.TryGetProperty("items", out var itemsEl) || itemsEl.ValueKind != JsonValueKind.Array)
                continue;
            items = new List<LightItem>(itemsEl.GetArrayLength());
            foreach (var el in itemsEl.EnumerateArray())
            {
                if (el.ValueKind != JsonValueKind.Object) continue;
                items.Add(LightItem.FromJson(el));
            }
        }
        catch { continue; }

        foreach (var item in items)
        {
            var opType = (item.OperationType ?? "").ToUpperInvariant();
            if (opType != "PICK_BY_LINE" && opType != "PIECE_SELECTION_PICKING") continue;
            if (!string.IsNullOrEmpty(opFilter) && !string.Equals(opType, opFilter, StringComparison.OrdinalIgnoreCase)) continue;

            var zone = GetZonePrefix(item.Cell);
            if (zone == "KDM" || zone == "MH") continue;  // Заморозка — исключаем
            if (!string.IsNullOrEmpty(zoneFilter) && !string.Equals(zone, zoneFilter, StringComparison.OrdinalIgnoreCase)) continue;

            var code = item.NomenclatureCode ?? "";
            var name = item.ProductName ?? "";
            if (string.IsNullOrWhiteSpace(code) && string.IsNullOrWhiteSpace(name)) continue;

            // Длительность операции в часах
            double durationHours = 0;
            if (!string.IsNullOrWhiteSpace(item.StartedAt) && !string.IsNullOrWhiteSpace(item.CompletedAt))
            {
                if (DateTime.TryParse(item.StartedAt,  null, System.Globalization.DateTimeStyles.AdjustToUniversal, out var tStart) &&
                    DateTime.TryParse(item.CompletedAt, null, System.Globalization.DateTimeStyles.AdjustToUniversal, out var tEnd))
                {
                    var secs = (tEnd - tStart).TotalSeconds;
                    // Отбрасываем аномальные значения: < 1 сек или > 2 часов
                    if (secs >= 1 && secs <= 7200)
                        durationHours = secs / 3600.0;
                }
            }

            var qty = ParseQty(item.Quantity);

            var key = new AggKey(code, name, zone, opType);
            var val = agg.GetOrAdd(key, _ => new AggValue());
            lock (val)
            {
                val.TotalOps++;
                val.TotalQty      += qty;
                val.PersonHours   += durationHours;
                val.OpsWithTime   += durationHours > 0 ? 1 : 0;
            }
        }
    }
});

// ─── Build result ──────────────────────────────────────────────────────────────

var results = agg
    .Select(kv =>
    {
        var k = kv.Key;
        var v = kv.Value;
        double qtyPerHour  = v.PersonHours > 0 ? Math.Round(v.TotalQty  / v.PersonHours, 2) : 0;
        double opsPerHour  = v.PersonHours > 0 ? Math.Round(v.TotalOps  / v.PersonHours, 2) : 0;
        return new ArticleSpeedResult(
            NomenclatureCode : k.Code,
            ProductName      : k.Name,
            Zone             : k.Zone,
            OperationType    : k.OpType,
            TotalOps         : v.TotalOps,
            TotalQty         : v.TotalQty,
            PersonHours      : Math.Round(v.PersonHours, 4),
            QtyPerPersonHour : qtyPerHour,
            OpsPerPersonHour : opsPerHour
        );
    })
    .OrderByDescending(r => r.TotalOps)
    .ToList();

Console.WriteLine(JsonSerializer.Serialize(new
{
    ok        = true,
    dateFrom,
    dateTo,
    count     = results.Count,
    results,
}, new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    WriteIndented = false,
}));

// ─── Helpers ───────────────────────────────────────────────────────────────────

static string GetZonePrefix(string? cell)
{
    if (string.IsNullOrWhiteSpace(cell)) return "";
    var dash = cell.IndexOf('-');
    return dash > 0 ? cell[..dash] : cell;
}

static double ParseQty(string? qty)
{
    if (string.IsNullOrWhiteSpace(qty)) return 0;
    return double.TryParse(qty.Replace(',', '.'), System.Globalization.NumberStyles.Any,
        System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : 0;
}

string GetArg(string key, string defaultValue)
{
    for (var i = 0; i < args.Length - 1; i++)
        if (args[i].Equals(key, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
    return defaultValue;
}

// ─── Types ─────────────────────────────────────────────────────────────────────

record AggKey(string Code, string Name, string Zone, string OpType);

class AggKeyComparer : IEqualityComparer<AggKey>
{
    public static readonly AggKeyComparer Instance = new();
    public bool Equals(AggKey? x, AggKey? y) =>
        x != null && y != null &&
        string.Equals(x.Code, y.Code, StringComparison.Ordinal) &&
        string.Equals(x.Zone, y.Zone, StringComparison.Ordinal) &&
        string.Equals(x.OpType, y.OpType, StringComparison.Ordinal);
    public int GetHashCode(AggKey k) =>
        HashCode.Combine(k.Code, k.Zone, k.OpType);
}

class AggValue
{
    public int    TotalOps    { get; set; }
    public double TotalQty    { get; set; }
    public double PersonHours { get; set; }
    public int    OpsWithTime { get; set; }
}

record ArticleSpeedResult(
    string NomenclatureCode,
    string ProductName,
    string Zone,
    string OperationType,
    int    TotalOps,
    double TotalQty,
    double PersonHours,
    double QtyPerPersonHour,
    double OpsPerPersonHour
);

record LightItem
{
    public string? OperationType    { get; init; }
    public string? NomenclatureCode { get; init; }
    public string? ProductName      { get; init; }
    public string? Cell             { get; init; }
    public string? StartedAt        { get; init; }
    public string? CompletedAt      { get; init; }
    public string? Executor         { get; init; }
    public string? Quantity         { get; init; }

    public static LightItem FromJson(JsonElement el)
    {
        static string Get(JsonElement o, string n) =>
            o.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        return new LightItem
        {
            OperationType    = Get(el, "operationType"),
            NomenclatureCode = Get(el, "nomenclatureCode"),
            ProductName      = Get(el, "productName"),
            Cell             = Get(el, "cell"),
            StartedAt        = Get(el, "startedAt"),
            CompletedAt      = Get(el, "completedAt"),
            Executor         = Get(el, "executor"),
            Quantity         = Get(el, "quantity"),
        };
    }
}
