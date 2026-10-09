namespace Organizator.Services;

/// <summary>
/// Tarif public de l'API Anthropic, en dollars par million de jetons, pour estimer ce qu'aurait
/// coute une session Claude Code facturee a l'usage (l'abonnement, lui, compte en quotas). Releve
/// du 9 octobre 2026 : ecriture du cache = 1,25 x l'entree pour 5 minutes, 2 x pour 1 heure ; la
/// lecture du cache a son propre prix selon le modele. Un modele inconnu n'est pas chiffre : ses
/// jetons sont comptes, son cout non (<see cref="SessionUsage.Unpriced"/>).
/// </summary>
public static class ModelPricing
{
    /// <summary>Prix d'un modele : entree, sortie, lecture du cache ($/MTok).</summary>
    private sealed record Price(double Input, double Output, double CacheRead);

    // Du prefixe le plus long au plus court : « claude-opus-5-5 » avant « claude-opus-5 ».
    private static readonly (string Prefix, Price Price)[] Table =
    {
        ("claude-fable-5-1", new Price(10, 50, 0.25)),
        ("claude-mythos-5-1", new Price(10, 50, 0.25)),
        ("claude-fable-5", new Price(10, 50, 1.00)),
        ("claude-mythos-5", new Price(10, 50, 1.00)),
        ("claude-opus-5-5", new Price(4, 20, 0.20)),
        ("claude-opus-5", new Price(5, 25, 0.50)),
        ("claude-opus-4-8", new Price(5, 25, 0.50)),
        ("claude-opus-4-7", new Price(5, 25, 0.50)),
        ("claude-opus-4-6", new Price(5, 25, 0.50)),
        ("claude-opus-4-5", new Price(5, 25, 0.50)),
        ("claude-sonnet-5-5", new Price(2, 10, 0.20)),
        ("claude-sonnet-5", new Price(2, 10, 0.20)),
        ("claude-sonnet-4", new Price(3, 15, 0.30)),
        ("claude-haiku-5-5", new Price(0.10, 0.50, 0.01)),
        ("claude-haiku-4-5", new Price(1, 5, 0.10)),
    };

    /// <summary>Recherche web cote serveur : 10 $ les mille.</summary>
    private const double WebSearch = 0.01;

    /// <summary>
    /// Cout d'un appel du modele, ou <c>null</c> si le modele n'est pas dans la grille. Le mode
    /// rapide d'Opus double le prix ; au-dela de 100 000 jetons de prompt, Haiku 5.5 passe a
    /// 0,50 / 2,50 $.
    /// </summary>
    public static double? Cost(string model, long input, long cacheWrite5m, long cacheWrite1h, long cacheRead, long output, long webSearches, bool fast)
    {
        var price = Find(model);
        if (price is null)
        {
            return null;
        }

        var factor = fast ? 2.0 : 1.0;
        var p = price;
        if (model.StartsWith("claude-haiku-5-5", StringComparison.OrdinalIgnoreCase)
            && input + cacheWrite5m + cacheWrite1h + cacheRead > 100_000)
        {
            p = new Price(0.50, 2.50, 0.05);
        }

        var dollars = (input * p.Input
            + cacheWrite5m * p.Input * 1.25
            + cacheWrite1h * p.Input * 2
            + cacheRead * p.CacheRead
            + output * p.Output) / 1_000_000 * factor;
        return dollars + webSearches * WebSearch;
    }

    private static Price? Find(string model)
    {
        if (string.IsNullOrWhiteSpace(model))
        {
            return null;
        }

        // Variante de contexte « [1m] » ou suffixe de date : le prefixe suffit.
        var id = model.Trim().ToLowerInvariant();
        foreach (var (prefix, price) in Table)
        {
            if (id.StartsWith(prefix, StringComparison.Ordinal))
            {
                return price;
            }
        }

        return null;
    }
}

/// <summary>
/// Consommation d'une session, sous-agents compris : jetons par categorie, cout estime au tarif
/// public (<see cref="ModelPricing"/>), et pour Copilot les requetes premium decomptees par GitHub.
/// <paramref name="Unpriced"/> : jetons d'un modele hors grille, comptes mais non chiffres.
/// </summary>
public sealed record SessionUsage(
    long Input,
    long Output,
    long CacheRead,
    long CacheWrite,
    double Cost,
    long Unpriced,
    double PremiumRequests,
    IReadOnlyList<ModelUsage> Models)
{
    public static readonly SessionUsage Empty = new(0, 0, 0, 0, 0, 0, 0, Array.Empty<ModelUsage>());

    public long Tokens => Input + Output + CacheRead + CacheWrite;

    public bool IsEmpty => Tokens == 0 && PremiumRequests <= 0;
}

/// <summary>Part d'un modele dans la consommation d'une session.</summary>
public sealed record ModelUsage(string Model, long Tokens, double Cost);
