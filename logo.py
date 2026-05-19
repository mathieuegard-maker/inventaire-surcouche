import os
from PIL import Image, ImageDraw, ImageFont

def generate_rounded_icon(size, text, filename):
    # Paramètres de style
    bg_color = (253, 253, 246, 255)  # Blanc crème léger (RGBA)
    text_color = (0, 0, 0, 255)      # Noir
    radius = int(size * 0.15)        # Rayon pour les angles arrondis (15% de la taille)
    
    # Création d'une image de base transparente
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    
    # Dessin du fond avec angles arrondis
    draw.rounded_rectangle([(0, 0), (size, size)], radius=radius, fill=bg_color)
    
    # Calcul de la taille de police pour occuper environ 70% de la hauteur/largeur
    target_font_size = int(size * 0.7)
    
    # Tentative de chargement d'une police système
    # Note : Pour une police spécifiquement "fine", tu peux remplacer "arial.ttf" 
    # par le chemin absolu vers un fichier .ttf spécifique (ex: "Montserrat-Light.ttf")
    try:
        if os.name == 'nt': # Windows
            font = ImageFont.truetype("arial.ttf", target_font_size)
        else: # macOS / Linux
            font = ImageFont.truetype("Helvetica", target_font_size)
    except IOError:
        try:
            # Fallback générique Linux
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", target_font_size)
        except IOError:
            # Fallback de dernier recours (risque d'être pixelisé et non "fin")
            font = ImageFont.load_default()

    # Calcul de la boîte englobante (bounding box) du texte pour le centrage
    bbox = draw.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    
    # Ajustement pour s'assurer que la largeur du texte ne dépasse pas les 70% visés
    current_font_size = target_font_size
    max_width = size * 0.7
    while text_w > max_width and current_font_size > 10:
        current_font_size -= 5
        try:
            font = ImageFont.truetype(font.path, current_font_size)
        except Exception:
            pass
        bbox = draw.textbbox((0, 0), text, font=font)
        text_w = bbox[2] - bbox[0]
        text_h = bbox[3] - bbox[1]

    # Calcul des coordonnées X et Y pour un centrage parfait
    x = (size - text_w) / 2 - bbox[0]
    y = (size - text_h) / 2 - bbox[1]
    
    # Insertion du texte sur l'image
    draw.text((x, y), text, font=font, fill=text_color)
    
    # Vérification et création du dossier de destination
    output_dir = "public"
    os.makedirs(output_dir, exist_ok=True)
    
    # Sauvegarde du fichier PNG
    output_path = os.path.join(output_dir, filename)
    image.save(output_path)
    print(f"Image générée avec succès : {output_path} ({size}x{size})")

if __name__ == "__main__":
    generate_rounded_icon(512, "Inv", "512.png")
    generate_rounded_icon(192, "Inv", "192.png")