namespace Organizator.Services;

/// <summary>
/// Ce que <see cref="AppSettings.Sanitize"/> prend a <c>BitbucketPullRequests</c> de l'hote WPF : la
/// normalisation de l'adresse. La classe d'origine (quotas, PRs, jetons) n'a pas sa place sur le serveur ;
/// copie conforme, a garder alignee.
/// </summary>
public static class BitbucketPullRequests
{
    /// <summary>Adresse absolue http(s), sans barre finale ; null pour tout le reste.</summary>
    public static string? NormalizeUrl(string? value)
    {
        var text = value?.Trim();
        if (string.IsNullOrEmpty(text) || !Uri.TryCreate(text, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            return null;
        }

        return text.TrimEnd('/');
    }
}
