using System.Text.Json;

var inputPath = GetArg("--input", "");
var dataDir = GetArg("--data-dir", "backend/data");
if (string.IsNullOrWhiteSpace(inputPath) || !File.Exists(inputPath))
{
    Console.Error.WriteLine("Missing --input");
    Environment.Exit(2);
}

Directory.CreateDirectory(dataDir);

var addedTotal = 0;
var skippedTotal = 0;
var byShift = new Dictionary<string, ShiftStat>(StringComparer.Ordinal);

using (var fs = File.OpenRead(inputPath))
using (var doc = JsonDocument.Parse(fs))
{
    if (!TryGetItems(doc.RootElement, out var items))
    {
        WriteResult(0, 0, byShift);
        return;
    }

    var byDateHour = new Dictionary<(string Date, int Hour), List<JsonElement>>();

    foreach (var item in items.EnumerateArray())
    {
        if (item.ValueKind != JsonValueKind.Object) continue;
        if (!item.TryGetProperty("operationCompletedAt", out var tsProp)) continue;
        var ts = tsProp.GetString();
        if (string.IsNullOrWhiteSpace(ts)) continue;

        var (dateStr, hour) = GetMoscowDateHour(ts);
        var key = (dateStr, hour);
        if (!byDateHour.TryGetValue(key, out var list))
        {
            list = new List<JsonElement>();
            byDateHour[key] = list;
        }
        list.Add(item);
    }

    foreach (var kv in byDateHour)
    {
        var dateStr = kv.Key.Date;
        var hour = kv.Key.Hour;
        var shiftKey = GetShiftKeyFromMoscowDateHour(dateStr, hour);
        if (!byShift.TryGetValue(shiftKey, out var shift))
        {
            shift = new ShiftStat();
            byShift[shiftKey] = shift;
        }

        var existing = LoadHourly(dataDir, dateStr, hour);
        var added = 0;
        var skipped = 0;

        foreach (var item in kv.Value)
        {
            var mergeKey = GetMergeKey(item);
            if (existing.ContainsKey(mergeKey))
            {
                skipped++;
                continue;
            }
            existing[mergeKey] = ToLightItem(item);
            added++;
        }

        SaveHourly(dataDir, dateStr, hour, existing.Values);

        shift.Added += added;
        shift.Skipped += skipped;
        shift.Total = existing.Count;
        addedTotal += added;
        skippedTotal += skipped;
    }
}

WriteResult(addedTotal, skippedTotal, byShift);

string GetArg(string key, string defaultValue)
{
    for (var i = 0; i < args.Length; i++)
    {
        if (!args[i].Equals(key, StringComparison.OrdinalIgnoreCase)) continue;
        if (i + 1 < args.Length) return args[i + 1];
    }
    return defaultValue;
}

static (string DateStr, int Hour) GetMoscowDateHour(string ts)
{
    var d = DateTime.Parse(ts, null, System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal);
    var moscow = d.AddHours(3);
    var dateStr = moscow.ToString("yyyy-MM-dd");
    var hour = moscow.Hour;
    return (dateStr, hour);
}

static string GetShiftKeyFromMoscowDateHour(string dateStr, int hour)
{
    if (hour >= 9 && hour < 21) return $"{dateStr}_day";
    if (hour >= 21) return $"{dateStr}_night";
    var d = DateTime.Parse(dateStr, null, System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal);
    var prev = d.AddDays(-1);
    return $"{prev:yyyy-MM-dd}_night";
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
    }
    items = default;
    return false;
}

static string GetString(JsonElement obj, string name)
{
    return obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
}

static string GetMergeKey(JsonElement item)
{
    var type = GetString(item, "operationType");
    var type2 = GetString(item, "type");
    var op = (string.IsNullOrWhiteSpace(type) ? type2 : type).ToUpperInvariant();
    var isTask = op == "PICK_BY_LINE" || op == "PIECE_SELECTION_PICKING";
    if (isTask)
    {
        var exec = GetResponsibleUserIdOrName(item);
        var cell = GetCell(item);
        var product = GetProductKey(item);
        return $"task|{exec}|{cell}|{product}";
    }
    return $"id|{GetString(item, "id")}";
}

static string GetResponsibleUserIdOrName(JsonElement item)
{
    if (item.TryGetProperty("responsibleUser", out var ru) && ru.ValueKind == JsonValueKind.Object)
    {
        if (ru.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String) return id.GetString() ?? "";
        var last = ru.TryGetProperty("lastName", out var ln) && ln.ValueKind == JsonValueKind.String ? ln.GetString() : "";
        var first = ru.TryGetProperty("firstName", out var fn) && fn.ValueKind == JsonValueKind.String ? fn.GetString() : "";
        return $"{last} {first}".Trim();
    }
    return "";
}

static string GetCell(JsonElement item)
{
    if (item.TryGetProperty("targetAddress", out var ta) && ta.ValueKind == JsonValueKind.Object)
    {
        if (ta.TryGetProperty("cellAddress", out var c) && c.ValueKind == JsonValueKind.String) return c.GetString() ?? "";
    }
    if (item.TryGetProperty("sourceAddress", out var sa) && sa.ValueKind == JsonValueKind.Object)
    {
        if (sa.TryGetProperty("cellAddress", out var c) && c.ValueKind == JsonValueKind.String) return c.GetString() ?? "";
    }
    return "";
}

static string GetProductKey(JsonElement item)
{
    if (item.TryGetProperty("product", out var p) && p.ValueKind == JsonValueKind.Object)
    {
        if (p.TryGetProperty("nomenclatureCode", out var nc) && nc.ValueKind == JsonValueKind.String)
        {
            var v = nc.GetString();
            if (!string.IsNullOrWhiteSpace(v)) return v!;
        }
        if (p.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String)
        {
            return n.GetString() ?? "";
        }
    }
    return "";
}

static Dictionary<string, LightItem> LoadHourly(string dataDir, string dateStr, int hour)
{
    var dir = Path.Combine(dataDir, dateStr);
    var file = Path.Combine(dir, hour.ToString("D2") + ".json");
    if (!File.Exists(file)) return new Dictionary<string, LightItem>(StringComparer.Ordinal);
    try
    {
        using var fs = File.OpenRead(file);
        using var doc = JsonDocument.Parse(fs);
        if (!doc.RootElement.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array)
            return new Dictionary<string, LightItem>(StringComparer.Ordinal);

        var map = new Dictionary<string, LightItem>(StringComparer.Ordinal);
        foreach (var el in items.EnumerateArray())
        {
            if (el.ValueKind != JsonValueKind.Object) continue;
            var li = LightItem.FromJson(el);
            var key = GetMergeKeyFromLight(li);
            if (!map.ContainsKey(key)) map[key] = li;
        }
        return map;
    }
    catch
    {
        return new Dictionary<string, LightItem>(StringComparer.Ordinal);
    }
}

static void SaveHourly(string dataDir, string dateStr, int hour, IEnumerable<LightItem> items)
{
    var dir = Path.Combine(dataDir, dateStr);
    Directory.CreateDirectory(dir);
    var file = Path.Combine(dir, hour.ToString("D2") + ".json");
    var obj = new
    {
        date = dateStr,
        hour = hour,
        updatedAt = DateTime.UtcNow.ToString("o"),
        items = items.ToArray(),
    };
    var json = JsonSerializer.Serialize(obj, new JsonSerializerOptions
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    });
    // Записываем во временный файл рядом, затем атомарно заменяем целевой.
    // Это позволяет избежать IOException когда несколько процессов пишут
    // в один и тот же файл одновременно.
    var tmp = file + ".tmp" + Environment.ProcessId;
    File.WriteAllText(tmp, json);
    File.Move(tmp, file, overwrite: true);
}

static string GetMergeKeyFromLight(LightItem light)
{
    var op = (light.OperationType ?? light.Type ?? "").ToUpperInvariant();
    var isTask = op == "PICK_BY_LINE" || op == "PIECE_SELECTION_PICKING";
    if (isTask)
    {
        var exec = light.Executor ?? "";
        var cell = light.Cell ?? "";
        var product = light.NomenclatureCode ?? light.ProductName ?? "";
        return $"task|{exec}|{cell}|{product}";
    }
    return $"id|{light.Id ?? ""}";
}

static LightItem ToLightItem(JsonElement item)
{
    var ru = item.TryGetProperty("responsibleUser", out var ruEl) && ruEl.ValueKind == JsonValueKind.Object ? ruEl : default;
    var last = ru.ValueKind == JsonValueKind.Object && ru.TryGetProperty("lastName", out var ln) && ln.ValueKind == JsonValueKind.String ? ln.GetString() : "";
    var first = ru.ValueKind == JsonValueKind.Object && ru.TryGetProperty("firstName", out var fn) && fn.ValueKind == JsonValueKind.String ? fn.GetString() : "";
    var middle = ru.ValueKind == JsonValueKind.Object && ru.TryGetProperty("middleName", out var mn) && mn.ValueKind == JsonValueKind.String ? mn.GetString() : "";
    var executor = string.Join(" ", new[] { last, first, middle }.Where(s => !string.IsNullOrWhiteSpace(s)));
    var executorId = ru.ValueKind == JsonValueKind.Object && ru.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String ? id.GetString() : "";

    string productName = "";
    string nomenclatureCode = "";
    string barcodes = "";
    if (item.TryGetProperty("product", out var p) && p.ValueKind == JsonValueKind.Object)
    {
        if (p.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String) productName = n.GetString() ?? "";
        if (p.TryGetProperty("nomenclatureCode", out var nc) && nc.ValueKind == JsonValueKind.String) nomenclatureCode = nc.GetString() ?? "";
        if (p.TryGetProperty("barcodes", out var bc) && bc.ValueKind == JsonValueKind.Array)
        {
            var list = new List<string>();
            foreach (var b in bc.EnumerateArray()) if (b.ValueKind == JsonValueKind.String) list.Add(b.GetString() ?? "");
            barcodes = string.Join(", ", list);
        }
    }

    string cell = "";
    if (item.TryGetProperty("targetAddress", out var ta) && ta.ValueKind == JsonValueKind.Object)
    {
        if (ta.TryGetProperty("cellAddress", out var c) && c.ValueKind == JsonValueKind.String) cell = c.GetString() ?? "";
    }
    if (string.IsNullOrWhiteSpace(cell) && item.TryGetProperty("sourceAddress", out var sa) && sa.ValueKind == JsonValueKind.Object)
    {
        if (sa.TryGetProperty("cellAddress", out var c) && c.ValueKind == JsonValueKind.String) cell = c.GetString() ?? "";
    }

    string quantity = "";
    if (item.TryGetProperty("targetQuantity", out var tq) && tq.ValueKind == JsonValueKind.Object)
    {
        if (tq.TryGetProperty("newQuantity", out var v) && v.ValueKind != JsonValueKind.Null) quantity = v.ToString();
    }
    if (string.IsNullOrWhiteSpace(quantity) && item.TryGetProperty("sourceQuantity", out var sq) && sq.ValueKind == JsonValueKind.Object)
    {
        if (sq.TryGetProperty("oldQuantity", out var v) && v.ValueKind != JsonValueKind.Null) quantity = v.ToString();
    }

    return new LightItem
    {
        Id = GetString(item, "id"),
        Type = GetString(item, "type"),
        OperationType = GetString(item, "operationType"),
        ProductName = productName,
        NomenclatureCode = nomenclatureCode,
        Barcodes = barcodes,
        ProductionDate = item.TryGetProperty("part", out var part) && part.ValueKind == JsonValueKind.Object && part.TryGetProperty("productionDate", out var pd) && pd.ValueKind == JsonValueKind.String ? pd.GetString() : "",
        BestBeforeDate = item.TryGetProperty("part", out part) && part.ValueKind == JsonValueKind.Object && part.TryGetProperty("bestBeforeDate", out var bd) && bd.ValueKind == JsonValueKind.String ? bd.GetString() : "",
        SourceBarcode = item.TryGetProperty("sourceAddress", out var saddr) && saddr.ValueKind == JsonValueKind.Object && saddr.TryGetProperty("handlingUnitBarcode", out var sh) && sh.ValueKind == JsonValueKind.String ? sh.GetString() : "",
        Cell = cell,
        TargetBarcode = item.TryGetProperty("targetAddress", out var taddr) && taddr.ValueKind == JsonValueKind.Object && taddr.TryGetProperty("handlingUnitBarcode", out var th) && th.ValueKind == JsonValueKind.String ? th.GetString() : "",
        StartedAt = GetString(item, "operationStartedAt"),
        CompletedAt = GetString(item, "operationCompletedAt"),
        Executor = executor,
        ExecutorId = executorId,
        SrcOld = item.TryGetProperty("sourceQuantity", out var so) && so.ValueKind == JsonValueKind.Object && so.TryGetProperty("oldQuantity", out var soV) && soV.ValueKind != JsonValueKind.Null ? soV.ToString() : "",
        SrcNew = item.TryGetProperty("sourceQuantity", out var sn) && sn.ValueKind == JsonValueKind.Object && sn.TryGetProperty("newQuantity", out var snV) && snV.ValueKind != JsonValueKind.Null ? snV.ToString() : "",
        TgtOld = item.TryGetProperty("targetQuantity", out var to) && to.ValueKind == JsonValueKind.Object && to.TryGetProperty("oldQuantity", out var toV) && toV.ValueKind != JsonValueKind.Null ? toV.ToString() : "",
        TgtNew = item.TryGetProperty("targetQuantity", out var tn) && tn.ValueKind == JsonValueKind.Object && tn.TryGetProperty("newQuantity", out var tnV) && tnV.ValueKind != JsonValueKind.Null ? tnV.ToString() : "",
        Quantity = quantity,
    };
}

static void WriteResult(int added, int skipped, Dictionary<string, ShiftStat> byShift)
{
    var res = new
    {
        ok = true,
        added,
        skipped,
        byShift = byShift.ToDictionary(k => k.Key, v => new { added = v.Value.Added, skipped = v.Value.Skipped, total = v.Value.Total })
    };
    Console.WriteLine(JsonSerializer.Serialize(res));
}

record ShiftStat
{
    public int Added { get; set; }
    public int Skipped { get; set; }
    public int Total { get; set; }
}

record LightItem
{
    public string? Id { get; set; }
    public string? Type { get; set; }
    public string? OperationType { get; set; }
    public string? ProductName { get; set; }
    public string? NomenclatureCode { get; set; }
    public string? Barcodes { get; set; }
    public string? ProductionDate { get; set; }
    public string? BestBeforeDate { get; set; }
    public string? SourceBarcode { get; set; }
    public string? Cell { get; set; }
    public string? TargetBarcode { get; set; }
    public string? StartedAt { get; set; }
    public string? CompletedAt { get; set; }
    public string? Executor { get; set; }
    public string? ExecutorId { get; set; }
    public string? SrcOld { get; set; }
    public string? SrcNew { get; set; }
    public string? TgtOld { get; set; }
    public string? TgtNew { get; set; }
    public string? Quantity { get; set; }

    public static LightItem FromJson(JsonElement el)
    {
        string Get(JsonElement o, string n) => o.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : v.ToString();
        return new LightItem
        {
            Id = Get(el, "id"),
            Type = Get(el, "type"),
            OperationType = Get(el, "operationType"),
            ProductName = Get(el, "productName"),
            NomenclatureCode = Get(el, "nomenclatureCode"),
            Barcodes = Get(el, "barcodes"),
            ProductionDate = Get(el, "productionDate"),
            BestBeforeDate = Get(el, "bestBeforeDate"),
            SourceBarcode = Get(el, "sourceBarcode"),
            Cell = Get(el, "cell"),
            TargetBarcode = Get(el, "targetBarcode"),
            StartedAt = Get(el, "startedAt"),
            CompletedAt = Get(el, "completedAt"),
            Executor = Get(el, "executor"),
            ExecutorId = Get(el, "executorId"),
            SrcOld = Get(el, "srcOld"),
            SrcNew = Get(el, "srcNew"),
            TgtOld = Get(el, "tgtOld"),
            TgtNew = Get(el, "tgtNew"),
            Quantity = Get(el, "quantity"),
        };
    }
}
