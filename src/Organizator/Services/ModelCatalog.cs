using System.Text.Json.Nodes;

namespace Organizator.Services;

/// <summary>
/// Un modele proposable dans l'UI. <c>Name</c>, <c>Usage</c> (multiplicateur, ex. <c>1x</c>) et
/// <c>Price</c> (<c>low</c>/<c>medium</c>/<c>high</c>) ne sont connus que pour le catalogue Copilot.
/// </summary>
public sealed record ModelOption(string Id, string? Name = null, string? Usage = null, string? Price = null, bool Enabled = true);

/// <summary>
/// Groupe de la liste deroulante. <c>Key</c> est traduit cote UI : <c>alias</c>, <c>used</c>,
/// <c>auto</c>, <c>claude</c>, <c>gpt</c>, <c>gemini</c>, <c>grok</c>, <c>other</c>.
/// </summary>
public sealed record ModelGroup(string Key, IReadOnlyList<ModelOption> Items);

/// <summary>
/// Ce que l'UI recoit pour un agent : modele et effort par defaut de l'outil (ses propres reglages),
/// date de la derniere detection (0 = jamais) et groupes de modeles.
/// </summary>
public sealed record ModelCatalogInfo(string DefaultModel, string DefaultEffort, long FetchedAt, IReadOnlyList<ModelGroup> Groups)
{
    public JsonObject ToJson()
    {
        var groups = new JsonArray();
        foreach (var group in Groups)
        {
            var items = new JsonArray();
            foreach (var item in group.Items)
            {
                var node = new JsonObject { ["id"] = item.Id };
                if (!string.IsNullOrEmpty(item.Name)) node["name"] = item.Name;
                if (!string.IsNullOrEmpty(item.Usage)) node["usage"] = item.Usage;
                if (!string.IsNullOrEmpty(item.Price)) node["price"] = item.Price;
                if (!item.Enabled) node["enabled"] = false;
                items.Add(node);
            }

            groups.Add(new JsonObject { ["key"] = group.Key, ["items"] = items });
        }

        return new JsonObject
        {
            ["defaultModel"] = DefaultModel,
            ["defaultEffort"] = DefaultEffort,
            ["fetchedAt"] = FetchedAt,
            ["groups"] = groups,
        };
    }
}
