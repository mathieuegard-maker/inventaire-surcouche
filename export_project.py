import os

def export_project_to_txt(source_folder, output_file):
    # Liste des segments de chemins à ignorer absolument
    # On utilise des noms simples pour attraper le fichier/dossier partout
    ignored_patterns = {
        '.git', 
        'node_modules', 
        '__pycache__', 
        '.DS_Store', 
        '.env.local', 
        'export_project.py',
        'package-lock.json',
        '.svg',
        '.jpg',
        '.png',
        '.ico', 
        'jpeg'
    }
    
    # On convertit source_folder en chemin absolu pour des calculs propres
    abs_source = os.path.abspath(source_folder)
    
    with open(output_file, 'w', encoding='utf-8') as outfile:
        outfile.write(f"SÉCURITÉ : SYNTHÈSE DU DOSSIER {abs_source}\n")
        outfile.write("="*60 + "\n\n")
        
        for root, dirs, files in os.walk(abs_source):
            # 1. Sécurité au niveau des dossiers
            # On filtre 'dirs' pour ne pas entrer dans les dossiers ignorés
            dirs[:] = [d for d in dirs if d not in ignored_patterns]
            
            for file in files:
                # 2. Sécurité au niveau des fichiers
                # On ignore le fichier de sortie lui-même
                if file == output_file:
                    continue
                
                file_path = os.path.join(root, file)
                relative_path = os.path.relpath(file_path, abs_source)
                
                # Vérification de sécurité critique : 
                # Si l'un des éléments du chemin est dans 'ignored_patterns', on passe.
                path_parts = relative_path.split(os.sep)
                if any(part in ignored_patterns for part in path_parts):
                    continue

                outfile.write(f"\n{'#'*80}\n")
                outfile.write(f"### FICHIER : {relative_path}\n")
                outfile.write(f"{'#'*80}\n\n")
                
                try:
                    with open(file_path, 'r', encoding='utf-8') as infile:
                        outfile.write(infile.read())
                        outfile.write("\n")
                except (UnicodeDecodeError, Exception):
                    outfile.write(f"[CONTENU NON TEXTUEL OU ILLISIBLE : {file}]\n")
                
                outfile.write("\n")

if __name__ == "__main__":
    # Utilisation de '.' pour le dossier courant
    target_dir = "." 
    output_name = "full_project_code.txt"
    
    export_project_to_txt(target_dir, output_name)
    print(f"✅ Compilation sécurisée terminée. Fichier généré : {output_name}")