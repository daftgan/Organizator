using System.IO;
using System.Text.Json.Nodes;

namespace Organizator.Services;

/// <summary>
/// Message de l'utilisateur a Claude Code (entree stream-json) : le texte, et les images jointes en
/// blocs <c>image</c> (base64) — l'agent les voit comme une capture collee dans son terminal. Le
/// texte cite deja leur chemin (« Pièces jointes : »), si bien qu'une image trop lourde ou d'un
/// format que l'API ne lit pas reste ouvrable par l'outil Read.
/// </summary>
public static class MessageContent
{
    // L'API refuse une image de plus de 5 Mo une fois encodee en base64 : 3,75 Mo bruts.
    public const long MaxImageBytes = 3_750_000;

    // Bien au-dela de ce qu'on joint a un message ; garde-fou contre une liste demesuree.
    public const int MaxImages = 20;

    /// <summary>
    /// Le texte seul (une chaine, comme avant), ou un tableau de blocs — le texte, puis chaque image
    /// lisible — quand des images partent avec lui.
    /// </summary>
    public static JsonNode Build(string text, IReadOnlyList<string>? images, HostLog? log = null)
    {
        var blocks = new JsonArray();
        foreach (var path in images ?? Array.Empty<string>())
        {
            if (blocks.Count >= MaxImages)
            {
                break;
            }

            if (ImageBlock(path, log) is { } block)
            {
                blocks.Add(block);
            }
        }

        if (blocks.Count == 0)
        {
            return JsonValue.Create(text)!;
        }

        blocks.Insert(0, new JsonObject { ["type"] = "text", ["text"] = text });
        return blocks;
    }

    /// <summary>Nombre d'images d'un contenu rendu par <see cref="Build"/>.</summary>
    public static int ImageCount(JsonNode content)
        => content is JsonArray blocks ? blocks.Count(b => (string?)b?["type"] == "image") : 0;

    private static JsonObject? ImageBlock(string path, HostLog? log)
    {
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.Length == 0)
            {
                return null;
            }

            if (info.Length > MaxImageBytes)
            {
                log?.Info($"Image jointe trop lourde pour partir dans le message ({info.Length} octets) : l'agent a son chemin ({info.Name}).");
                return null;
            }

            var bytes = File.ReadAllBytes(info.FullName);
            // Le type se lit dans le contenu : une capture enregistree en .png peut etre un JPEG.
            var media = MediaType(bytes);
            if (media is null)
            {
                log?.Info($"Image jointe d'un format que l'API ne lit pas : l'agent a son chemin ({info.Name}).");
                return null;
            }

            return new JsonObject
            {
                ["type"] = "image",
                ["source"] = new JsonObject
                {
                    ["type"] = "base64",
                    ["media_type"] = media,
                    ["data"] = Convert.ToBase64String(bytes),
                },
            };
        }
        catch (Exception ex)
        {
            log?.Warn($"Image jointe illisible ({Path.GetFileName(path)}) : {ex.Message}");
            return null;
        }
    }

    /// <summary>PNG, JPEG, GIF ou WebP d'apres leurs premiers octets ; null pour tout autre format.</summary>
    internal static string? MediaType(byte[] bytes)
    {
        static bool Starts(byte[] data, params byte[] head)
            => data.Length >= head.Length && head.Select((b, i) => data[i] == b).All(x => x);

        if (Starts(bytes, 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
        {
            return "image/png";
        }

        if (Starts(bytes, 0xFF, 0xD8, 0xFF))
        {
            return "image/jpeg";
        }

        if (Starts(bytes, 0x47, 0x49, 0x46, 0x38))
        {
            return "image/gif";
        }

        if (bytes.Length >= 12 && Starts(bytes, 0x52, 0x49, 0x46, 0x46)
            && bytes[8] == 0x57 && bytes[9] == 0x45 && bytes[10] == 0x42 && bytes[11] == 0x50)
        {
            return "image/webp";
        }

        return null;
    }
}
